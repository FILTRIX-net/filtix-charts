import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const fixture = readFileSync(resolve('examples/react-terminal/src/grid-test.js'), 'utf8');
const captureStart = fixture.indexOf('      async function drawingObservation(terminal, cellId) {');
const captureEnd = fixture.indexOf('      async function checkpoint(spec) {', captureStart);
if (captureStart < 0 || captureEnd <= captureStart) throw Error('Actual fixture capture not found');
const captureSource = fixture.slice(captureStart, captureEnd);

// Expose the unchanged private validator only in this test module. Resolve its
// original pure dependencies; never import a production geometry evaluator.
const evidencePath = resolve('scripts/grid-evidence.mjs');
const evidence = readFileSync(evidencePath, 'utf8').replace(
  /from '(\.\/[^']+)'/g,
  (_match, relative: string) => `from '${new URL(relative, pathToFileURL(evidencePath)).href}'`,
);
test('actual grid capture preserves off-pane Fibonacci coordinates and rejects tampered evidence', async ({
  page,
}, testInfo) => {
  await page.goto('/drawing-test.html');
  await page.waitForFunction(() => !!window.drawingApi);
  const result = await page.evaluate(async (source) => {
    const api = window.drawingApi;
    const chart = api.chart;
    const host = document.getElementById('host')!;
    host.setAttribute('data-filtix-grid-cell', 'cell-1');
    const panes = [1, 2, 3].map((index) => chart.addPane({ id: `probe-${index}`, minHeight: 40 }));
    try {
      await chart.whenIdle();
      const projection = api.projection();
      const pane = projection.panes.find((item) => item.id === 'price')!;
      const height = pane.bottom - pane.top;
      const high = projection.yToPrice(pane.top + height * 0.25, 'price')!;
      const low = projection.yToPrice(pane.top + height * 0.75, 'price')!;
      const middle = (high + low) / 2;
      const pairs = [
        [middle, high + (high - low) * 2],
        [middle, low - (high - low) * 2],
        [low, high],
      ];
      for (let index = 0; index < 50; index++) {
        const prices = pairs[index % pairs.length]!;
        api.layer.store.add({
          id: `probe-fib-${index}`,
          type: 'fibonacci-retracement',
          points: [
            { time: api.data[20]!.time, price: prices[0]! },
            { time: api.data[30]!.time, price: prices[1]! },
          ],
          levels: [0, 0.5, 1, 2].map((ratio) => ({ ratio })),
        });
      }
      await chart.whenIdle();
      const capture = new Function('host', 'copy', source + '; return drawingObservation;')(
        document.body,
        (value: unknown) => structuredClone(value),
      );
      const captured = await capture({ chart, getDrawings: () => api.layer.store }, 'cell-1');
      const publicCoordinates = captured.geometry
        .slice(0, 3)
        .map((drawing: any) =>
          drawing.fibLevels.map((level: any) => chart.priceToCoordinate(level.price, 'price')),
        );
      return { captured, publicCoordinates };
    } finally {
      api.layer.store.clear();
      for (const pane of panes) pane.remove();
      host.removeAttribute('data-filtix-grid-cell');
      await chart.whenIdle();
    }
  }, captureSource);

  const drawingDocument = result.captured.document;
  const geometry = drawingDocument.drawings.map((drawing: any) => ({
    id: drawing.id,
    type: drawing.type,
    paneId: drawing.paneId,
    visible: drawing.visible,
    anchors: drawing.points.map(({ time, price }: any) => ({ time, price })),
    fibLevels: drawing.levels.map(({ ratio }: any) => ({
      ratio,
      price: drawing.points[0].price + (drawing.points[1].price - drawing.points[0].price) * ratio,
    })),
    text: null,
  }));
  const expected = {
    drawings: { document: drawingDocument, geometry },
    workspace: { layout: { panes: result.captured.drawingObservation.projection.panes } },
  };
  const observed = {
    drawings: { document: drawingDocument, geometry: result.captured.geometry },
    drawingObservation: result.captured.drawingObservation,
  };
  const validatorPath = testInfo.outputPath('actual-grid-drawing-validator.mjs');
  mkdirSync(dirname(validatorPath), { recursive: true });
  writeFileSync(validatorPath, evidence + '\nexport { validateDrawingCell };\n');
  let validateDrawingCell: any;
  try {
    ({ validateDrawingCell } = await new Function('url', 'return import(url)')(
      pathToFileURL(validatorPath).href,
    ));
  } finally {
    rmSync(validatorPath, { force: true });
  }
  const errors: string[] = [];
  validateDrawingCell(expected, observed, errors, 'real-chart');

  // Public clipping remains intentional: endpoints above/below and extensions
  // are null there, while the fixture must retain their actual primitive y.
  expect(result.publicCoordinates[0][2]).toBeNull();
  expect(result.publicCoordinates[1][2]).toBeNull();
  expect(result.publicCoordinates[2][2]).not.toBeNull();
  expect(result.publicCoordinates[2][3]).toBeNull();
  expect(errors).toEqual([]);
  const pane = observed.drawingObservation.projection.panes.find((item: any) => item.id === 'price');
  expect(observed.drawings.geometry[0].fibLevels[2].y).toBeLessThan(pane.top);
  expect(observed.drawings.geometry[1].fibLevels[2].y).toBeGreaterThan(pane.bottom);

  const badCoordinate = structuredClone(observed);
  badCoordinate.drawings.geometry[0].fibLevels[2].y += 1;
  const coordinateErrors: string[] = [];
  validateDrawingCell(expected, badCoordinate, coordinateErrors, 'tampered-coordinate');
  expect(coordinateErrors.some((message) => message.includes('Fibonacci level projection differs'))).toBe(
    true,
  );
  const badPaint = structuredClone(observed);
  const stroke = badPaint.drawingObservation.groups[0].calls.filter(
    (call: any) => call.method === 'stroke',
  )[2];
  stroke.path[0][2] += 1;
  stroke.path[1][2] += 1;
  const paintErrors: string[] = [];
  validateDrawingCell(expected, badPaint, paintErrors, 'tampered-paint');
  expect(paintErrors.some((message) => message.includes('actual Canvas paint differs'))).toBe(true);
});
