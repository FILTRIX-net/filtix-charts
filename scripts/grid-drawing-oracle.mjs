// Adapted pure geometry math from drawing-tools-oracle.mjs; no production evaluator imports.
import assert from 'node:assert/strict';
const close = (a, b, tolerance = 1e-6) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
function geometricPrice(a, b, ratio, scale) {
  if (ratio === 0) return a;
  if (ratio === 1) return b;
  if (scale === 'log')
    return a > 0 && b > 0 ? Math.exp(Math.log(a) + ratio * (Math.log(b) - Math.log(a))) : null;
  return ratio > 0 && ratio < 1
    ? a * (1 - ratio) + b * ratio
    : ((a / Math.max(Math.abs(a), Math.abs(b))) * (1 - ratio) +
        (b / Math.max(Math.abs(a), Math.abs(b))) * ratio) *
        Math.max(Math.abs(a), Math.abs(b));
}
function matchesPath(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every(
      (step, i) =>
        actual[i]?.[0] === step[0] && step.slice(1).every((value, j) => close(actual[i]?.[j + 1], value)),
    )
  );
}
function matchingCall(group, method, options = {}) {
  return group.calls.find(
    (call) =>
      call.method === method &&
      (options.path === undefined || matchesPath(call.path, options.path)) &&
      (options.args === undefined ||
        options.args.every((value, i) =>
          typeof value === 'number' ? close(call.args?.[i], value) : call.args?.[i] === value,
        )) &&
      (options.strokeStyle === undefined || call.strokeStyle === options.strokeStyle) &&
      (options.fillStyle === undefined || call.fillStyle === options.fillStyle) &&
      (options.lineWidth === undefined || close(call.lineWidth, options.lineWidth, 1e-6)) &&
      (options.globalAlpha === undefined || close(call.globalAlpha, options.globalAlpha, 1e-6)) &&
      (options.font === undefined || call.font === options.font) &&
      (options.textBaseline === undefined || call.textBaseline === options.textBaseline) &&
      (options.lineDash === undefined || JSON.stringify(call.lineDash) === JSON.stringify(options.lineDash)),
  );
}
const consumedCalls = new WeakMap();
function requireCall(group, method, options, label) {
  const consumed = consumedCalls.get(group);
  const index = group.calls.findIndex(
    (call, index) => !consumed.has(index) && matchingCall({ calls: [call] }, method, options),
  );
  assert.ok(index >= 0, label + ': missing or mismatched ' + method);
  consumed.add(index);
}
function segment(group, a, b, color, width, dash, label) {
  requireCall(
    group,
    'stroke',
    {
      path: [
        ['moveTo', a.x, a.y],
        ['lineTo', b.x, b.y],
      ],
      strokeStyle: color,
      lineWidth: width,
      lineDash: dash,
      globalAlpha: 1,
    },
    label,
  );
}
function basisY(basis, price, scale) {
  if (!basis) return null;
  const [a, b] = basis;
  const pa = scale === 'log' ? Math.log(a.price) : a.price;
  const pb = scale === 'log' ? Math.log(b.price) : b.price;
  const p = scale === 'log' ? Math.log(price) : price;
  return a.y + ((p - pa) / (pb - pa)) * (b.y - a.y);
}
export function verifyGridDrawingPaint(document, observation) {
  assert.equal(document.drawings.length, 50);
  assert.equal(observation.groups.length, 50);
  assert.equal(observation.projection.panes.length, 4, 'actual four-pane projection is required');
  const anchor = (id, i) =>
    observation.projection.anchors.find((item) => item.sourceId === id && item.pointIndex === i);
  for (let i = 0; i < document.drawings.length; i++) {
    const drawing = document.drawings[i],
      group = observation.groups[i];
    assert.equal(drawing.visible, true, drawing.id + ': reference drawing must be visible');
    assert.equal(drawing.paneId, 'price', drawing.id + ': reference drawing must be in price pane');
    assert.equal(group.sourceIndex, i, 'Canvas source index mismatch');
    assert.equal(group.sourceId, drawing.id, 'Canvas source ID mismatch');
    assert.ok(Array.isArray(group.calls), 'Canvas calls missing');
    consumedCalls.set(group, new Set());
    if (drawing.visible)
      assert.ok(group.calls.length > 0, drawing.id + ': visible drawing has no Canvas calls');
    if (!drawing.visible) {
      assert.equal(group.calls.length, 0, drawing.id + ': hidden drawing painted');
      continue;
    }
    const pane = observation.projection.panes.find((item) => item.id === drawing.paneId);
    assert.ok(
      pane &&
        ['linear', 'log'].includes(pane.scale) &&
        [pane.left, pane.top, pane.right, pane.bottom].every(Number.isFinite),
      drawing.id + ': pane geometry missing',
    );
    const anchors = drawing.points.map((_, pointIndex) => anchor(drawing.id, pointIndex));
    for (const point of anchors)
      assert.ok(
        point && [point.x, point.y, point.loadedIndex].every(Number.isFinite),
        drawing.id + ': loaded finite projected anchor missing',
      );
    const [a, b, c] = anchors;
    if (!a || !Number.isFinite(a.y) || (drawing.type !== 'horizontal-line' && !Number.isFinite(a.x))) {
      assert.fail(drawing.id + ': first anchor missing');
    }
    if (drawing.type === 'horizontal-line') {
      segment(
        group,
        { x: pane.left, y: a.y },
        { x: pane.right, y: a.y },
        drawing.style.color,
        drawing.style.lineWidth,
        [],
        drawing.id + ': horizontal line',
      );
    } else if (drawing.type === 'trend-line') {
      assert.ok(b && Number.isFinite(b.x) && Number.isFinite(b.y), drawing.id + ': second anchor missing');
      segment(group, a, b, drawing.style.color, drawing.style.lineWidth, [], drawing.id + ': trend line');
    } else if (drawing.type === 'rectangle' || drawing.type === 'measure') {
      assert.ok(b && Number.isFinite(b.x) && Number.isFinite(b.y), drawing.id + ': second anchor missing');
      const box = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
      requireCall(
        group,
        'fillRect',
        { args: box, fillStyle: drawing.style.color, globalAlpha: drawing.style.fillOpacity },
        drawing.id + ': rectangle fill',
      );
      requireCall(
        group,
        'strokeRect',
        { args: box, strokeStyle: drawing.style.color, lineWidth: drawing.style.lineWidth, globalAlpha: 1 },
        drawing.id + ': rectangle border',
      );
      if (drawing.type === 'measure') {
        const delta = drawing.points[1].price - drawing.points[0].price;
        const percent =
          drawing.points[0].price === 0 ? null : (delta / Math.abs(drawing.points[0].price)) * 100;
        const number = (value) => (value === null ? 'n/a' : Number(value.toPrecision(5)).toString());
        const label =
          number(delta) +
          ' (' +
          number(percent) +
          '%) · ' +
          number(Math.abs(drawing.points[1].time - drawing.points[0].time) / 86400000) +
          'd';
        const measured = observation.projection.measureMetrics?.[drawing.id];
        assert.ok(
          measured && measured.label === label && Number.isFinite(measured.width) && measured.width >= 0,
          drawing.id + ': independent measure text width missing',
        );
        const labelWidth = measured.width + 12;
        const labelX = Math.max(pane.left, Math.min(pane.right - labelWidth, box[0]));
        const labelY = Math.max(pane.top, Math.min(pane.bottom - 22, box[1]));
        requireCall(
          group,
          'fillRect',
          {
            args: [labelX, labelY, labelWidth, 22],
            fillStyle: observation.projection.theme.background,
            globalAlpha: 1,
          },
          drawing.id + ': measure label background',
        );
        requireCall(
          group,
          'fillText',
          {
            args: [label, labelX + 6, labelY + 5],
            fillStyle: drawing.style.color,
            globalAlpha: 1,
            font: '12px sans-serif',
            textBaseline: 'top',
          },
          drawing.id + ': measure label',
        );
      }
    } else if (drawing.type === 'fibonacci-retracement') {
      assert.ok(b && Number.isFinite(b.x), drawing.id + ': Fibonacci second anchor missing');
      for (const [levelIndex, level] of drawing.levels.entries()) {
        const price = geometricPrice(
          drawing.points[0].price,
          drawing.points[1].price,
          level.ratio,
          pane.scale,
        );
        if (!Number.isFinite(price)) continue;
        const basis = observation.projection.priceBasis?.[drawing.paneId];
        const expectedY = basisY(basis, price, pane.scale);
        assert.ok(Number.isFinite(expectedY), drawing.id + ': independent price projection basis missing');
        const color = level.color ?? drawing.style.color;
        const width = level.lineWidth ?? drawing.style.lineWidth;
        const dash = level.lineStyle === 'dashed' ? [6, 4] : level.lineStyle === 'dotted' ? [2, 3] : [];
        segment(
          group,
          { x: a.x, y: expectedY },
          { x: b.x, y: expectedY },
          color,
          width,
          dash,
          drawing.id + ': Fibonacci level ' + level.ratio,
        );
        const label = Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(price.toPrecision(6));
        const measured = observation.projection.fibonacciMetrics?.[drawing.id]?.[levelIndex];
        assert.ok(
          measured && measured.label === label && Number.isFinite(measured.width) && measured.width >= 0,
          drawing.id + ': independent Fibonacci text width missing',
        );
        const labelX = Math.max(
          pane.left + 4,
          Math.min(pane.right - measured.width - 4, Math.max(a.x, b.x) - measured.width),
        );
        const labelY = Math.max(pane.top, Math.min(pane.bottom - 11, expectedY - 13));
        if (pane.right - pane.left > 8 && pane.bottom - pane.top > 11)
          requireCall(
            group,
            'fillText',
            {
              args: [label, labelX, labelY, pane.right - pane.left - 8],
              fillStyle: color,
              globalAlpha: 1,
              font: '11px sans-serif',
              textBaseline: 'top',
            },
            drawing.id + ': Fibonacci label',
          );
      }
    } else if (drawing.type === 'parallel-channel') {
      assert.ok(
        [b, c].every((point) => point && [point.x, point.y].every(Number.isFinite)),
        drawing.id + ': channel anchor missing',
      );
      const d = { x: c.x + b.x - a.x, y: c.y + b.y - a.y };
      requireCall(
        group,
        'fill',
        {
          path: [
            ['moveTo', a.x, a.y],
            ['lineTo', b.x, b.y],
            ['lineTo', d.x, d.y],
            ['lineTo', c.x, c.y],
            ['closePath'],
          ],
          fillStyle: drawing.style.color,
          globalAlpha: drawing.style.fillOpacity,
        },
        drawing.id + ': channel polygon',
      );
      for (const [start, end, rail] of [
        [a, b, 'first rail'],
        [c, d, 'second rail'],
        [a, c, 'start crossbar'],
        [b, d, 'end crossbar'],
      ])
        segment(
          group,
          start,
          end,
          drawing.style.color,
          drawing.style.lineWidth,
          [],
          drawing.id + ': ' + rail,
        );
    } else if (drawing.type === 'text-note') {
      const lines = drawing.text.split('\n');
      const widths = observation.projection.textMetrics?.[drawing.id];
      assert.ok(
        Array.isArray(widths) &&
          widths.length === lines.length &&
          widths.every((width) => Number.isFinite(width) && width >= 0),
        drawing.id + ': text metrics missing',
      );
      const box = [a.x, a.y, Math.max(12, ...widths) + 12, lines.length * drawing.fontSize * 1.25 + 12];
      requireCall(
        group,
        'fillRect',
        {
          args: box,
          fillStyle: observation.projection.theme.background,
          globalAlpha: drawing.style.fillOpacity,
        },
        drawing.id + ': note box fill',
      );
      requireCall(
        group,
        'strokeRect',
        { args: box, strokeStyle: drawing.style.color, lineWidth: drawing.style.lineWidth, globalAlpha: 1 },
        drawing.id + ': note box border',
      );
      for (let line = 0; line < lines.length; line++)
        requireCall(
          group,
          'fillText',
          {
            args: [lines[line], a.x + 6, a.y + 6 + line * drawing.fontSize * 1.25],
            fillStyle: drawing.style.color,
            font: drawing.fontSize + 'px sans-serif',
            globalAlpha: 1,
            textBaseline: 'top',
          },
          drawing.id + ': note line ' + line,
        );
    }
    assert.equal(
      consumedCalls.get(group).size,
      group.calls.length,
      drawing.id + ': unexpected Canvas paint commands',
    );
  }
  return document.drawings.length;
}
