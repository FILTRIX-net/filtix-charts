import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error The canonical evidence scene is a plain JavaScript Node module.
import { buildGridScene } from '../../scripts/grid-oracle.mjs';

const cohort = 'benchmark-results/v0.11/runtime/cohort-2026-09-24T03-53-33-894Z/manifest.json';
const prefix = '/__owned-columns-proof/';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// Automatic trace screencast writes delayed Firefox context teardown after all
// functional checks passed. Retain calls, DOM snapshots and sources; this test's
// exact Canvas pixel/command comparisons and mismatch PNGs remain independent.
test.use({
  trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true },
});

test('owned study columns match the archived real chart through pages and tails', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const report: any = {
    qualification:
      'Functional old/built-candidate chart comparison; not installed grid or performance acceptance.',
    before: {},
    after: {},
    served: [],
    browser: null,
    browserRecovery: { status: 'not-attempted' },
    received: { binding: null, stages: [], outputs: [], cleanup: null, last: null, count: 0 },
    failures: [],
  };
  const journal = testInfo.outputPath('owned-study-columns-progress.jsonl');
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, '', { flag: 'wx' });
  let journalSequence = 0;
  const record = (entry: any) => {
    const receipt = { sequence: journalSequence++, nodeAt: Date.now(), ...entry };
    appendFileSync(journal, JSON.stringify(receipt) + '\n');
    report.received.last = receipt;
    report.received.count = journalSequence;
  };
  record({ phase: 'node-start' });
  const files = new Map<string, Buffer>();
  const remember = (path: string) => {
    const bytes = readFileSync(path);
    files.set(path, bytes);
    report.before[path] = { bytes: bytes.length, sha256: digest(bytes) };
    return bytes;
  };
  try {
    await page.exposeBinding('__ownedColumnsProgress', (_source, entry: any) => {
      record(entry);
      if (entry.phase === 'binding') report.received.binding = entry.binding;
      if (entry.phase === 'output-complete') report.received.outputs.push(entry);
      if (entry.phase === 'stage-complete') {
        report.received.stages.push(entry.receipt);
        console.log(`owned-columns ${testInfo.project.name}: ${entry.receipt.name}`);
      }
      if (entry.phase === 'cleanup') report.received.cleanup = entry.cleanup;
    });
    const manifest = JSON.parse(remember(cohort).toString());
    if (manifest.sourceCommit !== 'e028bc8c121f76e249092e4500cb344c803cdd26')
      throw Error('Unexpected old cohort source');
    const routes = new Map<string, Buffer>();
    for (const [url, original] of [
      ['old/charts/index.js', 'packages/charts/dist/index.js'],
      ['old/charts/index.js.map', 'packages/charts/dist/index.js.map'],
      ['old/indicators/internal.js', 'packages/indicators/dist/internal.js'],
      ['old/indicators/internal.js.map', 'packages/indicators/dist/internal.js.map'],
    ]) {
      const entry = manifest.files.find((item: any) => item.original === original);
      if (!entry) throw Error(`Missing archived module ${original}`);
      const bytes = remember(entry.stored);
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
        throw Error(`Archived module identity mismatch: ${original}`);
      routes.set(prefix + url, bytes);
    }
    for (const path of [
      'packages/charts/dist/index.js',
      'packages/charts/dist/index.js.map',
      'packages/charts/dist/internal.js',
      'packages/charts/dist/internal.js.map',
      'packages/indicators/dist/internal.js',
      'packages/indicators/dist/internal.js.map',
    ])
      routes.set(prefix + 'new/' + path.replace('packages/', '').replace('/dist/', '/'), remember(path));
    // Bind build/source inputs as well as the exact executable response bodies.
    for (const path of [
      'packages/charts/src/chart.ts',
      'packages/charts/src/index.ts',
      'packages/core/src/store.ts',
      'packages/core/src/index.ts',
      'packages/indicators/src/internal.ts',
      'packages/indicators/src/indicators.ts',
      'packages/indicators/src/macd.ts',
      'packages/indicators/src/bollinger.ts',
      'packages/terminal/src/study-runtime.ts',
      'packages/charts/package.json',
      'packages/indicators/package.json',
      'tsup.config.ts',
      'scripts/build-charts-internal.mjs',
      'scripts/grid-oracle.mjs',
      'scripts/multi-output-oracle.mjs',
      'tests/browser/owned-study-columns-parity.spec.ts',
    ])
      remember(path);
    await page.route('**' + prefix + '**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === prefix + 'harness.html') {
        await route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111}</style>',
        });
        return;
      }
      const body = routes.get(path);
      if (!body) {
        report.failures.push(`Unbound module request: ${path}`);
        await route.abort();
        return;
      }
      report.served.push({ url: path, bytes: body.length, sha256: digest(body) });
      await route.fulfill({
        contentType: path.endsWith('.map') ? 'application/json' : 'text/javascript',
        body,
      });
    });
    await page.goto(prefix + 'harness.html');
    const cell = buildGridScene({ rowsPerCell: 100_000, seed: 20260922 }).cells[0];
    report.input = {
      cell: cell.id,
      query: cell.query,
      rows: cell.rows.length,
      sha256: digest(JSON.stringify(cell.rows)),
      studies: cell.studies,
    };
    record({ phase: 'node-bound-inputs', identity: report.before, input: report.input });
    await page.evaluate(
      async ({ cell, prefix }) => {
        const ledger: any = {
          binding: null,
          stages: [],
          attempted: null,
          errors: [],
          cleanup: null,
          projection:
            'Ordered path/paint calls; applicable paint state, transform and dash. Native methods always forwarded.',
        };
        (window as any).__ownedColumnsProof = ledger;
        const progress = (phase: string, detail: Record<string, unknown> = {}) => {
          const sent: Promise<void> = (window as any).__ownedColumnsProgress({
            phase,
            browserAt: performance.now(),
            ...detail,
          });
          // Non-awaited markers bracket synchronous paired chart operations without
          // inserting a frame between the old and new operation. Failures stay visible.
          void sent.catch((error: unknown) =>
            ledger.errors.push(`Progress delivery failed: ${String(error)}`),
          );
          return sent;
        };
        const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
        const originalContext = HTMLCanvasElement.prototype.getContext;
        const originals = new Map<string, (...args: any[]) => any>();
        const owners: any[] = [];
        const commandBuffers: any = { old: { scene: [], overlay: [] }, next: { scene: [], overlay: [] } };
        const require = (condition: unknown, message: string) => {
          if (!condition) throw Error(message);
        };
        const equal = (a: any, b: any): boolean => {
          if (Object.is(a, b)) return true;
          if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
          const keys = Object.keys(a);
          return (
            keys.length === Object.keys(b).length &&
            keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
          );
        };
        // BEGIN EXACT PRIMITIVE SERIES POINT COMPARATOR (extracted by the Node control).
        function compareSeriesPoint(a: Record<string, unknown>, b: Record<string, unknown>): number {
          if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return -1;
          let keys = 0;
          let negativeZero = 0;
          for (const key in a) {
            if (!Object.hasOwn(a, key)) continue;
            keys++;
            const value = a[key];
            if (
              (value !== null && (typeof value === 'object' || typeof value === 'function')) ||
              !Object.prototype.propertyIsEnumerable.call(b, key) ||
              !Object.is(value, b[key])
            )
              return -1;
            if (Object.is(value, -0)) negativeZero++;
          }
          for (const key in b) if (Object.hasOwn(b, key)) keys--;
          return keys === 0 ? negativeZero : -1;
        }
        // END EXACT PRIMITIVE SERIES POINT COMPARATOR.
        const sha = async (text: string) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('');
        try {
          await progress('imports-start');
          const oldUrl = prefix + 'old/charts/index.js';
          const newUrl = prefix + 'new/charts/index.js';
          const internalUrl = prefix + 'new/charts/internal.js';
          const oldIndicatorsUrl = prefix + 'old/indicators/internal.js';
          const newIndicatorsUrl = prefix + 'new/indicators/internal.js';
          const [oldModule, newModule, bridge, oldIndicators, newIndicators] = await Promise.all([
            import(/* @vite-ignore */ oldUrl),
            import(/* @vite-ignore */ newUrl),
            import(/* @vite-ignore */ internalUrl),
            import(/* @vite-ignore */ oldIndicatorsUrl),
            import(/* @vite-ignore */ newIndicatorsUrl),
          ]);
          ledger.binding = {
            distinctFactories: oldModule.createChart !== newModule.createChart,
            sharedSetter: newModule.setOwnedStudyColumns === bridge.setOwnedStudyColumns,
            sharedCapability:
              newModule.hasOwnedStudyColumnCapability === bridge.hasOwnedStudyColumnCapability,
            oldExports: Object.keys(oldModule).sort(),
            newExports: Object.keys(newModule).sort(),
          };
          await progress('binding', { binding: ledger.binding });
          require(ledger.binding.distinctFactories &&
            ledger.binding.sharedSetter &&
            ledger.binding.sharedCapability, 'Old/new or root/shim module identity failed');
          HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            type: any,
            settings: any,
          ) {
            return originalContext.call(
              this,
              type,
              type === '2d' ? { ...settings, willReadFrequently: true } : settings,
            );
          } as typeof originalContext;
          const pathMethods = [
            'save',
            'restore',
            'beginPath',
            'closePath',
            'moveTo',
            'lineTo',
            'rect',
            'arc',
            'arcTo',
            'bezierCurveTo',
            'quadraticCurveTo',
            'ellipse',
            'clip',
          ];
          const paintMethods = [
            'clearRect',
            'fillRect',
            'strokeRect',
            'fill',
            'stroke',
            'fillText',
            'strokeText',
          ];
          for (const method of [...pathMethods, ...paintMethods]) {
            const prototype = CanvasRenderingContext2D.prototype as any;
            const native = prototype[method];
            originals.set(method, native);
            prototype[method] = function (this: CanvasRenderingContext2D, ...args: any[]) {
              const host = this.canvas.closest<HTMLElement>('[data-owned-proof]');
              const layer = this.canvas.getAttribute('data-filtix-layer');
              if (host && (layer === 'scene' || layer === 'overlay')) {
                const transform = this.getTransform();
                const row: any = {
                  method,
                  args,
                  transform: [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f],
                };
                if (paintMethods.includes(method) && method !== 'clearRect') {
                  row.alpha = this.globalAlpha;
                  row.composite = this.globalCompositeOperation;
                  if (method.startsWith('stroke')) {
                    row.style = String(this.strokeStyle);
                    row.width = this.lineWidth;
                    row.dash = this.getLineDash();
                    row.dashOffset = this.lineDashOffset;
                    row.cap = this.lineCap;
                    row.join = this.lineJoin;
                    row.miter = this.miterLimit;
                  } else row.style = String(this.fillStyle);
                  if (method.endsWith('Text')) {
                    row.font = this.font;
                    row.align = this.textAlign;
                    row.baseline = this.textBaseline;
                  }
                }
                commandBuffers[host.dataset.ownedProof!][layer].push(row);
              }
              return native.apply(this, args);
            };
          }
          const descriptors = (kind: string): [string, string][] =>
            kind === 'macd'
              ? [
                  ['macd', 'line'],
                  ['signal', 'line'],
                  ['histogram', 'histogram'],
                ]
              : kind === 'bollinger'
                ? [
                    ['middle', 'line'],
                    ['upper', 'line'],
                    ['lower', 'line'],
                    ['fill', 'band'],
                  ]
                : [['value', 'line']];
          const requests = cell.studies.map((study: any) =>
            study.kind === 'macd'
              ? {
                  kind: study.kind,
                  options: {
                    fastPeriod: study.fastPeriod,
                    slowPeriod: study.slowPeriod,
                    signalPeriod: study.signalPeriod,
                  },
                }
              : study.kind === 'bollinger'
                ? { kind: study.kind, options: { period: study.period, multiplier: study.multiplier } }
                : { kind: study.kind, period: study.period },
          );
          const mount = (side: string, module: any) => {
            const host = document.createElement('div');
            host.dataset.ownedProof = side;
            host.style.cssText = 'width:640px;height:480px;';
            document.body.append(host);
            const owner: any = {
              side,
              host,
              chart: null,
              handles: new Map(),
              controllers: [],
              cursor: null,
              events: [],
            };
            owners.push(owner);
            owner.chart = module.createChart(host, {
              width: 640,
              height: 480,
              autoSize: false,
              followLatest: false,
              maxPixelRatio: 1,
              timeDomain: 'utc-ms',
              timeZone: 'UTC',
              locale: 'en-US',
              theme: 'dark',
              diagnostics: true,
              crosshair: true,
            });
            for (const pane of cell.workspace.layout.panes.slice(1)) owner.chart.addPane(pane);
            owner.chart.applyPaneLayout({ panes: cell.workspace.layout.panes, maximizedPaneId: null });
            owner.handles.set('price', owner.chart.addSeries('candlestick', { id: 'price' }));
            owner.handles.set(
              'volume',
              owner.chart.addSeries('histogram', {
                id: 'volume',
                paneId: 'terminal-volume-pane',
                color: '#596980',
              }),
            );
            cell.studies.forEach((study: any, index: number) => {
              for (const [key, type] of descriptors(study.kind)) {
                const id = `${index}:${key}`;
                const color =
                  (
                    {
                      signal: study.signalColor,
                      upper: study.upperColor,
                      lower: study.lowerColor,
                      fill: study.fillColor,
                    } as Record<string, string>
                  )[key] ?? study.color;
                owner.handles.set(
                  id,
                  owner.chart.addSeries(type, {
                    id,
                    paneId:
                      study.kind === 'rsi' || study.kind === 'macd' ? `terminal-${study.id}-pane` : 'price',
                    color,
                    lineWidth: study.lineWidth,
                    ...(key === 'histogram'
                      ? { upColor: study.positiveColor, downColor: study.negativeColor }
                      : {}),
                    ...(type === 'band' ? { fillOpacity: study.fillOpacity } : {}),
                  }),
                );
              }
            });
            owner.chart.subscribeCrosshairMove((event: any, meta: any) => {
              owner.cursor = event;
              owner.events.push({ kind: 'cursor', event, meta });
            });
            owner.chart.subscribeVisibleRangeChange((range: any, meta: any) =>
              owner.events.push({ kind: 'range', range, meta }),
            );
            return owner;
          };
          const old = mount('old', oldModule),
            next = mount('next', newModule);
          ledger.binding.oldCapable = bridge.hasOwnedStudyColumnCapability(old.chart);
          ledger.binding.nextCapable = bridge.hasOwnedStudyColumnCapability(next.chart);
          await progress('binding', { binding: ledger.binding });
          require(!ledger.binding.oldCapable &&
            ledger.binding.nextCapable, 'Capability did not bind the actual chart module');
          const fillPoint = (upper: any, lower: any) => {
            if (!upper || !lower || upper.time !== lower.time)
              throw Error('Bollinger outputs must be aligned by time');
            const a = 'value' in upper ? upper.value : undefined,
              b = 'value' in lower ? lower.value : undefined;
            if (a === undefined && b === undefined) return { time: upper.time };
            if (a === undefined || b === undefined)
              throw Error('Bollinger boundaries must become ready together');
            return { time: upper.time, upper: a, lower: b };
          };
          const rebuild = (owner: any, rows: any[]) => {
            owner.handles.get('price').setData(rows);
            owner.handles.get('volume').setData(rows.map(({ time, volume }) => ({ time, value: volume })));
            const points = rows.map((bar) => ({ time: bar.time, value: bar.close }));
            const isOld = owner === old;
            // All study mathematics and all fill checks precede the first study copy.
            const prepared = new Map<number, any>();
            const collect = () => {
              const owned = isOld ? null : newIndicators.prepareOwnedBatch(requests, points, 'utc-ms');
              if (owned) require(owned.points === points, 'Owned batch changed the shared time source');
              const batch = isOld ? oldIndicators.prepareBatch(requests, points, 'utc-ms') : owned.studies;
              batch.forEach((study: any, index: number) => {
                const data = isOld ? study.prepared.data : study.outputs;
                if (study.kind === 'bollinger') {
                  if (isOld) {
                    require(data.upper.length === data.lower.length, 'Fill lengths differ');
                    data.fill = data.upper.map((point: any, i: number) => fillPoint(point, data.lower[i]));
                  } else {
                    require(data.upper.values.length === points.length &&
                      data.lower.values.length === points.length &&
                      data.upper.present.length === points.length &&
                      data.lower.present.length === points.length, 'Owned fill lengths differ');
                    for (let i = 0; i < points.length; i++)
                      require(data.upper.present[i] ===
                        data.lower.present[i], 'Owned fill readiness differs');
                    data.fill = { kind: 'band', upper: data.upper, lower: data.lower };
                  }
                }
                prepared.set(index, {
                  kind: study.kind,
                  data: isOld && !['macd', 'bollinger'].includes(study.kind) ? { value: data } : data,
                  controller: isOld ? study.prepared.controller : study.controller,
                });
              });
            };
            collect(); // The batch array's scope ends before publication.
            for (const [index, study] of prepared) {
              for (const [key] of descriptors(study.kind)) {
                const handle = owner.handles.get(`${index}:${key}`);
                if (isOld) handle.setData(study.data[key]);
                else
                  bridge.setOwnedStudyColumns(
                    owner.chart,
                    handle,
                    points,
                    key === 'fill' ? study.data.fill : { kind: 'scalar', column: study.data[key] },
                  );
              }
              owner.controllers[index] = { kind: study.kind, controller: study.controller };
              prepared.delete(index);
            }
          };
          const tail = (owner: any, bar: any, indicatorOnly = false) => {
            if (!indicatorOnly) {
              const { time, open, high, low, close, volume } = bar;
              owner.handles.get('price').update({ time, open, high, low, close, volume });
              owner.handles.get('volume').update({ time, value: volume });
            }
            const point = indicatorOnly ? { time: bar.time } : { time: bar.time, value: bar.close };
            owner.controllers.forEach(({ kind, controller }: any, index: number) => {
              const result = controller.update(point);
              const outputs =
                kind === 'bollinger'
                  ? { ...result, fill: fillPoint(result.upper, result.lower) }
                  : kind === 'macd'
                    ? result
                    : { value: result };
              for (const [key] of descriptors(kind))
                owner.handles.get(`${index}:${key}`).update(outputs[key]);
            });
          };
          const resetObservation = () => {
            for (const owner of owners) {
              owner.events = [];
              commandBuffers[owner.side] = { scene: [], overlay: [] };
            }
          };
          await progress('initial-settle-start');
          await Promise.all(owners.map((owner) => owner.chart.whenIdle()));
          await progress('initial-settle-complete');
          const snapshot = async (
            name: string,
            rows: number,
            range: { from: number; to: number },
            cursorTime: number,
          ) => {
            const receipt: any = {
              name,
              rows,
              requestedRange: range,
              cursorTime,
              outputs: [],
              failures: [],
              visuals: {},
              public: {},
            };
            ledger.stages.push(receipt); // Retain the attempted stage before any comparison can throw.
            void progress('stage-start', { name, rows, range, cursorTime });
            for (const owner of owners) owner.chart.setVisibleRange(range);
            void progress('range-settle-start', { name });
            await Promise.all(owners.map((owner) => owner.chart.whenIdle()));
            await progress('range-settle-complete', { name });
            for (const owner of owners) owner.chart.setCrosshairTime(cursorTime);
            void progress('cursor-settle-start', { name });
            await Promise.all(owners.map((owner) => owner.chart.whenIdle()));
            await progress('cursor-settle-complete', { name });
            for (const [id, handle] of old.handles) {
              await progress('get-data-start', { name, id, side: 'old' });
              const a = handle.getData();
              await progress('get-data-complete', { name, id, side: 'old', rows: a.length });
              await progress('get-data-start', { name, id, side: 'next' });
              const b = next.handles.get(id).getData();
              await progress('get-data-complete', { name, id, side: 'next', rows: b.length });
              let mismatch: any =
                a.length === b.length && a.length === rows
                  ? null
                  : { reason: 'length', old: a.length, next: b.length, expected: rows };
              let negativeZero = 0;
              await progress('compare-start', { name, id, rows: a.length });
              let compared = 0;
              for (let first = 0; first < a.length && !mismatch; first += 8192) {
                const end = Math.min(first + 8192, a.length);
                for (let i = first; i < end; i++) {
                  const count = compareSeriesPoint(a[i], b[i]);
                  compared++;
                  if (count < 0) {
                    mismatch = { row: i, old: a[i], next: b[i] };
                    break;
                  }
                  negativeZero += count;
                }
                await yieldTask();
                if (end % 32768 === 0 || end === a.length)
                  await progress('compare-progress', { name, id, compared, rows: a.length });
              }
              await progress('compare-complete', { name, id, compared, mismatch });
              await progress('data-hash-start', { name, id, rows: a.length });
              const output = {
                id,
                rows: a.length,
                compared,
                sha256: await sha(JSON.stringify(a)),
                negativeZero,
                mismatch,
              };
              receipt.outputs.push(output);
              await progress('output-complete', { name, output });
              if (mismatch) receipt.failures.push(`Data mismatch ${id}`);
            }
            require(receipt.outputs.length === 12, 'Expected twelve actual output handles');
            for (const owner of owners)
              receipt.public[owner.side] = {
                range: owner.chart.getVisibleRange(),
                timeRange: owner.chart.getVisibleTimeRange(),
                panes: owner.chart.getPaneLayout(),
                coordinate: owner.chart.timeToCoordinate(cursorTime),
                cursor: owner.cursor,
                events: owner.events,
                diagnostics: owner.chart.getDiagnostics(),
              };
            for (const key of ['range', 'timeRange', 'panes', 'coordinate', 'cursor', 'events'])
              if (!equal(receipt.public.old[key], receipt.public.next[key]))
                receipt.failures.push(`Public ${key} mismatch`);
            await progress('public-complete', { name, failures: receipt.failures });
            if (old.cursor?.time !== cursorTime || next.cursor?.time !== cursorTime)
              receipt.failures.push('Cursor failed to resolve visible loaded time');
            if (
              old.chart.getDiagnostics().seriesCount !== 12 ||
              next.chart.getDiagnostics().seriesCount !== 12 ||
              old.chart.getPaneLayout().panes.length !== 4 ||
              next.chart.getPaneLayout().panes.length !== 4
            )
              receipt.failures.push('Scene composition differs');
            for (const layer of ['scene', 'overlay']) {
              await progress('readback-start', { name, layer });
              const canvases = owners.map(
                (owner) => owner.host.querySelector(`[data-filtix-layer="${layer}"]`) as HTMLCanvasElement,
              );
              const contexts = canvases.map((canvas) => canvas.getContext('2d')!);
              const pixels = contexts.map(
                (context, i) => context.getImageData(0, 0, canvases[i]!.width, canvases[i]!.height).data,
              );
              await progress('readback-complete', {
                name,
                layer,
                channels: pixels.map((data) => data.length),
              });
              let mismatches = 0;
              for (let i = 0; i < pixels[0]!.length; i++) if (pixels[0]![i] !== pixels[1]![i]) mismatches++;
              const nonuniform = pixels.map((data) => {
                for (let i = 4; i < data.length; i += 4)
                  if (
                    data[i] !== data[0] ||
                    data[i + 1] !== data[1] ||
                    data[i + 2] !== data[2] ||
                    data[i + 3] !== data[3]
                  )
                    return true;
                return false;
              });
              const oldCalls = commandBuffers.old[layer],
                newCalls = commandBuffers.next[layer];
              await progress('commands-compare-start', {
                name,
                layer,
                counts: [oldCalls.length, newCalls.length],
              });
              const commandEqual = equal(oldCalls, newCalls);
              await progress('commands-compare-complete', { name, layer, commandEqual });
              const painted = oldCalls.filter((call: any) =>
                ['stroke', 'fill', 'fillRect'].includes(call.method),
              ).length;
              const studyColors = new Set(
                cell.studies
                  .flatMap((study: any) => [
                    study.color,
                    study.signalColor,
                    study.positiveColor,
                    study.negativeColor,
                    study.upperColor,
                    study.lowerColor,
                    study.fillColor,
                  ])
                  .filter(Boolean)
                  .map((value: string) => value.toLowerCase()),
              );
              const seriesPaint = oldCalls.filter(
                (call: any) =>
                  ['stroke', 'fill', 'fillRect'].includes(call.method) && studyColors.has(call.style),
              ).length;
              const attributes = contexts.map((context) => context.getContextAttributes());
              await progress('commands-hash-start', { name, layer });
              const visual: any = {
                dimensions: canvases.map((canvas) => [canvas.width, canvas.height]),
                mismatches,
                nonuniform,
                commandEqual,
                commandCounts: [oldCalls.length, newCalls.length],
                painted,
                seriesPaint,
                commandHashes: [await sha(JSON.stringify(oldCalls)), await sha(JSON.stringify(newCalls))],
                attributes,
              };
              receipt.visuals[layer] = visual;
              if (mismatches || !commandEqual) {
                visual.calls = { old: oldCalls, next: newCalls };
                visual.pngs = canvases.map((canvas) => canvas.toDataURL());
              }
              if (
                mismatches ||
                !commandEqual ||
                !nonuniform.every(Boolean) ||
                painted === 0 ||
                (layer === 'scene' && seriesPaint === 0) ||
                !attributes.every((value) => value.willReadFrequently === true) ||
                !visual.dimensions.every((value: number[]) => value[0] === 640 && value[1] === 480)
              )
                receipt.failures.push(`${layer} visual proof failed`);
              await progress('layer-complete', { name, layer, visual });
            }
            ledger.attempted = null;
            await progress('stage-complete', { receipt });
            require(receipt.failures.length === 0, `${name}: ${receipt.failures.join('; ')}`);
          };
          for (let count = 10_000; count <= 100_000; count += 10_000) {
            ledger.attempted = { kind: 'progressive-page', count };
            await progress('action-start', { attempted: ledger.attempted });
            resetObservation();
            const rows = cell.rows.slice(-count);
            void progress('rebuild-start', { count, side: 'old' });
            rebuild(old, rows);
            void progress('rebuild-complete', { count, side: 'old' });
            void progress('rebuild-start', { count, side: 'next' });
            rebuild(next, rows);
            void progress('rebuild-complete', { count, side: 'next' });
            await snapshot(
              `page-${count}`,
              count,
              { from: count - 1000, to: count - 1 },
              rows[count - 101].time,
            );
          }
          for (const [name, from, to, index] of [
            ['dense', 0, 99999, 50000],
            ['tiny', 14, 33, 25],
            ['api-pan', 200, 1200, 700],
            ['api-zoom', 400, 800, 600],
          ] as const) {
            ledger.attempted = { kind: 'viewport', name, from, to };
            await progress('action-start', { attempted: ledger.attempted });
            resetObservation();
            const before = old.chart.getVisibleRange();
            await snapshot(name, 100_000, { from, to }, cell.rows[index].time);
            require(!equal(before, old.chart.getVisibleRange()), `${name} viewport action ineffective`);
          }
          const last = cell.rows[cell.rows.length - 1];
          const replacement = {
            ...last,
            close: last.close + 0.025,
            high: Math.max(last.high, last.close + 0.1),
          };
          const appended = { ...replacement, time: last.time + 60000 };
          for (const action of [
            { name: 'replace', bar: replacement, rows: 100_000, indicatorOnly: false },
            { name: 'append', bar: appended, rows: 100_001, indicatorOnly: false },
            { name: 'indicator-whitespace', bar: appended, rows: 100_001, indicatorOnly: true },
            { name: 'indicator-recovery', bar: appended, rows: 100_001, indicatorOnly: false },
          ]) {
            ledger.attempted = { kind: 'tail', ...action };
            await progress('action-start', { attempted: ledger.attempted });
            resetObservation();
            void progress('tail-start', { name: action.name, side: 'old' });
            tail(old, action.bar, action.indicatorOnly);
            void progress('tail-complete', { name: action.name, side: 'old' });
            void progress('tail-start', { name: action.name, side: 'next' });
            tail(next, action.bar, action.indicatorOnly);
            void progress('tail-complete', { name: action.name, side: 'next' });
            await snapshot(
              action.name,
              action.rows,
              { from: action.rows - 1000, to: action.rows - 1 },
              action.bar.time,
            );
          }
        } catch (error) {
          ledger.errors.push(error instanceof Error ? error.stack : String(error));
          void progress('browser-error', { error: ledger.errors.at(-1), attempted: ledger.attempted });
        } finally {
          const cleanup: any = { charts: [], errors: [] };
          for (const owner of owners) {
            try {
              owner.chart?.destroy();
              cleanup.charts.push({
                side: owner.side,
                retired: true,
                canvases: owner.host.querySelectorAll('canvas').length,
              });
            } catch (error) {
              cleanup.errors.push(String(error));
            } finally {
              owner.host.remove();
            }
          }
          for (const [method, native] of originals)
            (CanvasRenderingContext2D.prototype as any)[method] = native;
          HTMLCanvasElement.prototype.getContext = originalContext;
          cleanup.hostsRemaining = document.querySelectorAll('[data-owned-proof]').length;
          cleanup.contextRestored = HTMLCanvasElement.prototype.getContext === originalContext;
          cleanup.methodsRestored = [...originals].every(
            ([method, native]) => (CanvasRenderingContext2D.prototype as any)[method] === native,
          );
          ledger.cleanup = cleanup;
          await progress('cleanup', { cleanup });
        }
      },
      { cell, prefix },
    );
  } catch (error) {
    report.failures.push(error instanceof Error ? error.stack : String(error));
    record({ phase: 'node-error', error: report.failures.at(-1) });
  } finally {
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    record({ phase: 'recovery-start', deadlineMs: 3000 });
    try {
      // A test timeout does not interrupt synchronous browser JavaScript. Never
      // let the second evaluate prevent the already received Node journal/report
      // from reaching disk. This deadline does not claim to cancel page work.
      report.browser = await Promise.race([
        page.evaluate(() => (window as any).__ownedColumnsProof ?? null),
        new Promise<never>((_resolve, reject) => {
          recoveryTimer = setTimeout(
            () => reject(new Error('Renderer ledger recovery exceeded 3000ms')),
            3000,
          );
        }),
      ]);
      report.browserRecovery = { status: report.browser ? 'recovered' : 'missing' };
    } catch (error) {
      report.browserRecovery = { status: 'unrecovered', error: String(error) };
      report.failures.push(`Partial ledger recovery failed: ${String(error)}`);
    } finally {
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      record({ phase: 'recovery-complete', recovery: report.browserRecovery });
    }
    for (const [path, before] of files) {
      try {
        const bytes = readFileSync(path);
        report.after[path] = { bytes: bytes.length, sha256: digest(bytes) };
        if (!bytes.equals(before)) report.failures.push(`Identity changed: ${path}`);
      } catch (error) {
        report.failures.push(`Identity read failed ${path}: ${String(error)}`);
      }
    }
    for (const url of [
      'old/charts/index.js',
      'old/indicators/internal.js',
      'new/charts/index.js',
      'new/charts/internal.js',
      'new/indicators/internal.js',
    ])
      if (!report.served.some((entry: any) => entry.url === prefix + url))
        report.failures.push(`Expected module was not served: ${url}`);
    for (const stage of report.browser?.stages ?? report.received.stages)
      for (const [layer, visual] of Object.entries(stage.visuals ?? {}) as [string, any][]) {
        if (visual.pngs) {
          visual.pngPaths = [];
          for (const [index, png] of visual.pngs.entries()) {
            try {
              const path = testInfo.outputPath(
                `${stage.name}-${layer}-${index === 0 ? 'old' : 'candidate'}.png`,
              );
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, Buffer.from(png.split(',')[1], 'base64'));
              visual.pngPaths.push(path);
            } catch (error) {
              report.failures.push(`Mismatch PNG preservation failed: ${String(error)}`);
            }
          }
          delete visual.pngs;
        }
      }
    const path = testInfo.outputPath('owned-study-columns-parity.json');
    report.journal = { path: journal, entries: journalSequence };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
    await testInfo.attach('owned-study-columns-parity', { path, contentType: 'application/json' });
    await testInfo.attach('owned-study-columns-progress', {
      path: journal,
      contentType: 'application/x-ndjson',
    });
  }
  expect(report.failures).toEqual([]);
  expect(report.browser?.errors).toEqual([]);
  expect(report.browser?.stages).toHaveLength(18);
  expect(report.received.stages).toHaveLength(18);
  expect(report.received.outputs).toHaveLength(18 * 12);
  for (const entry of report.received.outputs) {
    expect(entry.output.mismatch).toBeNull();
    expect(entry.output.compared).toBe(entry.output.rows);
  }
  expect(report.browser?.cleanup.errors).toEqual([]);
  expect(report.browser?.cleanup.hostsRemaining).toBe(0);
  expect(report.browser?.cleanup.contextRestored).toBe(true);
  expect(report.browser?.cleanup.methodsRestored).toBe(true);
  expect(report.browser?.cleanup.charts).toHaveLength(2);
  for (const chart of report.browser?.cleanup.charts ?? []) expect(chart.canvases).toBe(0);
});
