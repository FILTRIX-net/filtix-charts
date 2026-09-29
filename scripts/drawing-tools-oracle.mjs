import assert from 'node:assert/strict';

export const DRAWING_MIX = Object.freeze({
  'trend-line': 30,
  'horizontal-line': 30,
  rectangle: 30,
  measure: 30,
  'fibonacci-retracement': 30,
  'parallel-channel': 25,
  'text-note': 25,
});
export const BUDGETS = Object.freeze({
  sceneSync: [1500, null],
  sceneSettled: [2000, null],
  restoreSync: [1500, null],
  restoreSettled: [2000, null],
  updateWork: [16, 32],
  updateSettled: [50, 100],
  navigationWork: [16, 32],
  navigationSettled: [50, 100],
  tailSync: [16, 32],
  tailSettled: [50, 100],
  wheelInclusive: [150, null],
});
const counts = {
  sceneSync: 3,
  sceneSettled: 3,
  restoreSync: 3,
  restoreSettled: 3,
  updateWork: 100,
  updateSettled: 100,
  navigationWork: 240,
  navigationSettled: 240,
  tailSync: 300,
  tailSettled: 300,
  wheelInclusive: 24,
};
const sha = /^[a-f0-9]{64}$/;
const close = (a, b, tolerance = 0.75) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

export function nearestRank(values, quantile) {
  assert.ok(
    Array.isArray(values) &&
      values.length > 0 &&
      values.every((value) => Number.isFinite(value) && value >= 0),
  );
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
}
export function summarize(values) {
  return {
    count: values.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: Math.max(...values),
  };
}
export function recordEvidenceAttempt(collection, candidate, validate, persist = () => {}) {
  assert.ok(Array.isArray(collection) && candidate && typeof validate === 'function');
  if (!collection.includes(candidate)) collection.push(candidate);
  candidate.status = 'collected';
  persist();
  try {
    const value = validate(candidate);
    candidate.status = 'accepted';
    persist();
    return value;
  } catch (error) {
    candidate.status = 'rejected';
    candidate.error = error instanceof Error ? error.message : String(error);
    persist();
    throw error;
  }
}
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
function requireCall(group, method, options, label) {
  assert.ok(matchingCall(group, method, options), label + ': missing or mismatched ' + method);
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
export function verifyDrawingCheckpoint(sample, { full = true } = {}) {
  assert.ok(sample && typeof sample === 'object');
  const { document, source, observation } = sample;
  assert.equal(document?.schema, 'filtix-drawings');
  assert.equal(document?.version, 2);
  assert.ok(Array.isArray(document.drawings));
  assert.ok(Number.isInteger(source?.rows) && source.rows > 0);
  if (full) {
    assert.equal(source.rows, 100_000, 'Full checkpoint requires 100k retained rows');
    assert.equal(document.drawings.length, 200, 'Full checkpoint requires 200 drawings');
    assert.deepEqual(
      sample.market,
      { symbol: 'BTCUSDT', interval: '1m' },
      'Full checkpoint market identity missing',
    );
  }
  assert.match(source?.sha256, sha);
  if (full) {
    assert.match(source?.expectedSha256, sha, 'Expected provider source hash missing');
    assert.equal(source.sha256, source.expectedSha256, 'Provider and terminal OHLCV differ');
    assert.ok(
      source.provenance?.fixture === 'drawing-tools-v1' &&
        Number.isFinite(source.provenance.firstTime) &&
        Array.isArray(source.provenance.events),
      'Reproducible provider provenance missing',
    );
    assert.deepEqual(source.bars, source.expectedBars, 'Expected and observed boundary OHLCV samples differ');
  }
  assert.ok(Array.isArray(source?.bars) && source.bars.length > 0, 'Source OHLCV sample missing');
  for (const bar of source.bars)
    assert.ok(
      ['time', 'open', 'high', 'low', 'close', 'volume'].every((key) => Number.isFinite(bar[key])),
      'Nonfinite source sample',
    );
  assert.equal(observation?.canvas, 'annotation');
  assert.ok(Array.isArray(observation.groups));
  assert.equal(
    observation.groups.length,
    document.drawings.length,
    'Canvas group count differs from source drawing count',
  );
  assert.ok(
    Array.isArray(observation.projection?.panes) && observation.projection.panes.length > 0,
    'Projection missing',
  );
  assert.ok(Array.isArray(observation.projection?.anchors), 'Projected anchors missing');
  assert.match(observation.pixel?.pngSha256, sha, 'Actual pixel hash missing');
  assert.ok(observation.pixel.width > 0 && observation.pixel.height > 0, 'Actual pixel dimensions missing');
  if (full)
    assert.match(
      observation.pixel.path,
      /^benchmark-results\/v0\.9\/drawing-tools-[^/]+\/pixels\/[^/]+\.png$/,
      'Retained PNG artifact path missing',
    );
  const anchor = (id, i) =>
    observation.projection.anchors.find((item) => item.sourceId === id && item.pointIndex === i);
  for (let i = 0; i < document.drawings.length; i++) {
    const drawing = document.drawings[i],
      group = observation.groups[i];
    if (full) {
      assert.equal(drawing.visible, true, drawing.id + ': reference drawing must be visible');
      assert.equal(drawing.paneId, 'price', drawing.id + ': reference drawing must be in price pane');
    }
    assert.equal(group.sourceIndex, i, 'Canvas source index mismatch');
    assert.equal(group.sourceId, drawing.id, 'Canvas source ID mismatch');
    assert.ok(Array.isArray(group.calls), 'Canvas calls missing');
    if (full && drawing.visible)
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
    if (full)
      for (const point of anchors)
        assert.ok(
          point && [point.x, point.y, point.loadedIndex].every(Number.isFinite),
          drawing.id + ': loaded finite projected anchor missing',
        );
    const [a, b, c] = anchors;
    if (!a || !Number.isFinite(a.y) || (drawing.type !== 'horizontal-line' && !Number.isFinite(a.x))) {
      if (full) assert.fail(drawing.id + ': first anchor missing');
      else continue;
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
            textBaseline: 'top',
          },
          drawing.id + ': note line ' + line,
        );
    }
  }
  return document.drawings.length;
}
function finiteRange(range) {
  return range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from;
}
function actionProof(item) {
  const { before, after } = item;
  if (!before || !after || item.verified !== true) return false;
  switch (item.action) {
    case 'selection-hide-show':
      return (
        before.visible === true &&
        after.visible === true &&
        after.hidden === true &&
        after.listed === true &&
        typeof after.selectedId === 'string' &&
        after.selectedId.length > 0
      );
    case 'lock':
      return typeof before.locked === 'boolean' && after.locked === !before.locked;
    case 'style':
    case 'level':
      return typeof after.color === 'string' && after.color.length > 0 && before.color !== after.color;
    case 'text':
      return typeof before.text === 'string' && typeof after.text === 'string' && before.text !== after.text;
    case 'undo-redo':
      return (
        typeof before.hashInput === 'string' &&
        before.hashInput.length > 0 &&
        after.hashInput === before.hashInput &&
        after.middleChanged === true
      );
    case 'save-restore':
      return (
        typeof before.hashInput === 'string' &&
        before.hashInput.length > 0 &&
        after.hashInput === before.hashInput
      );
    case 'market-isolation':
      return (
        before.drawings === 200 &&
        before.rows === 100000 &&
        after.isolatedDrawings === 0 &&
        after.drawings === 200 &&
        after.rows === 100000
      );
    case 'correction':
      return (
        before.bar &&
        after.actual &&
        after.expected &&
        Number.isFinite(before.bar.close) &&
        Number.isFinite(after.actual.close) &&
        after.actual.close !== before.bar.close &&
        JSON.stringify(after.actual) === JSON.stringify(after.expected)
      );
    case 'resize':
      return (
        Number.isFinite(before.width) &&
        Number.isFinite(after.width) &&
        Number.isFinite(after.duringWidth) &&
        after.duringWidth !== before.width &&
        Math.abs(after.width - before.width) < 1
      );
    default:
      return false;
  }
}
export function validateDrawingEvidence(result) {
  assert.equal(result.installation?.version, '0.9.0', 'Wrong installed cohort');
  assert.equal(result.installation.archives, 8);
  assert.equal(result.installation.members, 35);
  assert.match(result.installation.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(result.installation.identities) && result.installation.identities.length > 0);
  assert.equal(result.scene?.rows, 100_000);
  assert.ok(Math.abs(result.scene.visibleBars - 1000) <= 100);
  assert.equal(result.scene.series, 12);
  assert.equal(result.scene.panes, 4);
  assert.deepEqual(result.scene.drawingMix, DRAWING_MIX);
  assert.equal(result.warmup?.scope, 'full-scene');
  assert.deepEqual([result.warmup.rows, result.warmup.series, result.warmup.drawings], [100000, 12, 200]);
  assert.equal(result.maximumLimits?.levels, 32);
  assert.equal(result.maximumLimits?.lines, 20);
  assert.equal(result.maximumLimits?.checkpointId, 'maximum-limits-32-levels-20-lines');
  const rawCounts = {
    warmup: 1,
    scenes: 3,
    restores: 3,
    updates: 100,
    navigation: 240,
    tail: 600,
    wheel: 24,
  };
  for (const [name, minimum] of Object.entries(rawCounts)) {
    const attempts = result.raw?.[name];
    assert.ok(Array.isArray(attempts) && attempts.length >= minimum, name + ': raw attempts missing');
    if (name !== 'tail') assert.equal(attempts.length, minimum, name + ': unexpected attempt count');
    assert.ok(
      attempts.every((item) => item.status === 'accepted'),
      name + ': rejected raw attempt',
    );
  }
  for (const name of ['warmup', 'scenes', 'restores', 'updates', 'navigation', 'tail'])
    for (const item of result.raw[name])
      assert.ok(
        Number.isFinite(item.synchronousMs) &&
          item.synchronousMs >= 0 &&
          Number.isFinite(item.settledMs) &&
          item.settledMs >= item.synchronousMs &&
          Number.isFinite(item.renderMs) &&
          item.renderMs > 0 &&
          Number.isFinite(item.libraryWorkMs) &&
          Math.abs(item.libraryWorkMs - item.synchronousMs - item.renderMs) < 1e-6 &&
          item.frameSubmitted === true,
        name + ': invalid raw timing',
      );
  for (const name of ['warmup', 'scenes', 'restores'])
    for (const item of result.raw[name])
      assert.ok(
        Array.isArray(item.frames) &&
          item.frames.length > 0 &&
          item.frames.every((frame) => Number.isFinite(frame.renderMs) && frame.renderMs > 0) &&
          Math.abs(item.frames.reduce((sum, frame) => sum + frame.renderMs, 0) - item.renderMs) < 1e-6,
        name + ': missing frame work',
      );
  for (const name of ['warmup', 'scenes', 'restores'])
    for (const item of result.raw[name])
      assert.ok(
        Number.isFinite(item.operationWorkUpperBoundMs) &&
          Number.isFinite(item.components?.processingElapsedMs) &&
          Number.isFinite(item.components?.finalIdleDrainMs) &&
          item.components.processingElapsedMs >= item.synchronousMs &&
          item.components.finalIdleDrainMs >= 0 &&
          item.settledMs >= item.components.processingElapsedMs &&
          Math.abs(item.operationWorkUpperBoundMs - item.components.processingElapsedMs - item.renderMs) <
            1e-6,
        name + ': complete operation work upper bound missing',
      );
  assert.ok(
    result.raw.wheel.every(
      (item) => Number.isFinite(item.automationInclusiveMs) && item.automationInclusiveMs >= 0,
    ),
    'Wheel raw timing invalid',
  );
  assert.ok(
    result.raw.scenes.every(
      (item) =>
        item.scope === 'full-scene' && item.rows === 100000 && item.series === 12 && item.drawings === 200,
    ),
    'Full scene timing scope missing',
  );
  assert.ok(
    result.raw.warmup.every(
      (item) =>
        item.scope === 'full-scene' && item.rows === 100000 && item.series === 12 && item.drawings === 200,
    ),
    'Full warmup timing scope missing',
  );
  assert.ok(
    result.raw.restores.every(
      (item) =>
        item.scope === 'full-workspace-restore' &&
        item.rows === 100000 &&
        item.series === 12 &&
        item.drawings === 200,
    ),
    'Full workspace restore timing scope missing',
  );
  const summary = {};
  for (const [name, minimum] of Object.entries(counts)) {
    const values = result.samples?.[name];
    assert.ok(Array.isArray(values) && values.length >= minimum, name + ': missing samples');
    summary[name] = summarize(values);
    const [p95, p99] = BUDGETS[name];
    assert.ok(
      name === 'wheelInclusive' ? summary[name].p95 < p95 : summary[name].p95 <= p95,
      name + ': p95 budget',
    );
    if (p99 !== null) assert.ok(summary[name].p99 <= p99, name + ': p99 budget');
  }
  for (const [sampleName, rawName, field, count] of [
    ['sceneSync', 'scenes', 'operationWorkUpperBoundMs', 3],
    ['sceneSettled', 'scenes', 'settledMs', 3],
    ['restoreSync', 'restores', 'operationWorkUpperBoundMs', 3],
    ['restoreSettled', 'restores', 'settledMs', 3],
    ['updateWork', 'updates', 'libraryWorkMs', 100],
    ['updateSettled', 'updates', 'settledMs', 100],
    ['navigationWork', 'navigation', 'libraryWorkMs', 240],
    ['navigationSettled', 'navigation', 'settledMs', 240],
    ['tailSync', 'tail', 'synchronousMs', 300],
    ['tailSettled', 'tail', 'settledMs', 300],
    ['wheelInclusive', 'wheel', 'automationInclusiveMs', 24],
  ])
    assert.deepEqual(
      result.samples[sampleName],
      result.raw[rawName].slice(0, count).map((item) => item[field]),
      sampleName + ': summary differs from raw attempts',
    );
  const maximum = result.cadence?.maximum;
  assert.ok(Array.isArray(maximum) && maximum.length === 2);
  assert.deepEqual(
    maximum.map((phase) => phase.deliveries),
    [100, 200],
  );
  assert.deepEqual(
    maximum.map((phase) => phase.phase),
    ['replace', 'append-replace'],
    'Maximum tail phases must retain the fixed replacement then append/replacement workload',
  );
  for (const phase of maximum) {
    assert.equal(phase.targetIntervalMs, 100);
    assert.equal(phase.actualAt?.length, phase.deliveries);
    assert.equal(phase.targetAt?.length, phase.deliveries);
    assert.equal(phase.dispatchedAt?.length, phase.deliveries);
    assert.ok(
      [phase.actualAt, phase.targetAt, phase.dispatchedAt].every(
        (values) =>
          values.every(Number.isFinite) && values.every((value, i) => i === 0 || value > values[i - 1]),
      ),
    );
    for (let i = 1; i < phase.deliveries; i++)
      assert.equal(
        phase.targetAt[i] - phase.targetAt[i - 1],
        100,
        phase.phase + ': target schedule is not the 100 ms grid',
      );
  }
  for (const [phase, offset] of [
    [maximum[0], 0],
    [maximum[1], 100],
  ])
    for (let i = 0; i < phase.deliveries; i++) {
      const raw = result.raw.tail[offset + i];
      assert.equal(raw.deliveryPhase, phase.phase, 'Maximum raw phase missing');
      assert.deepEqual(
        [raw.targetAt, raw.dispatchedAt, raw.browserDeliveredAt],
        [phase.targetAt[i], phase.dispatchedAt[i], phase.actualAt[i]],
        'Maximum raw delivery time differs from browser cadence',
      );
      const expectedKind = phase.phase === 'replace' || i % 2 === 1 ? 'replace' : 'append';
      const expectedBefore = phase.phase === 'replace' ? 100000 : 99900 + Math.floor((i + 1) / 2);
      const expectedAfter = phase.phase === 'replace' ? 100000 : 99900 + Math.floor((i + 2) / 2);
      assert.deepEqual(
        [raw.sequence, raw.kind, raw.sourceRowsBefore, raw.sourceRowsAfter],
        [i, expectedKind, expectedBefore, expectedAfter],
        'Maximum tail kind, alternation or source row transition differs from workload',
      );
    }
  assert.ok(result.cadence.mixed.elapsedMs >= 120_000);
  assert.ok(result.cadence.mixed.deliveries >= 300);
  assert.equal(result.cadence.mixed.targetIntervalMs, 250);
  assert.ok(result.cadence.mixed.actualAt?.length >= 300);
  assert.equal(result.cadence.mixed.targetAt?.length, result.cadence.mixed.deliveries);
  assert.equal(result.cadence.mixed.dispatchedAt?.length, result.cadence.mixed.deliveries);
  for (const values of [
    result.cadence.mixed.actualAt,
    result.cadence.mixed.targetAt,
    result.cadence.mixed.dispatchedAt,
  ])
    assert.ok(
      values.every(Number.isFinite) && values.every((value, i) => i === 0 || value > values[i - 1]),
      'Mixed browser delivery/dispatch cadence invalid',
    );
  assert.equal(
    result.raw.tail.length,
    300 + result.cadence.mixed.deliveries,
    'Mixed raw delivery count differs from cadence',
  );
  for (let i = 0; i < result.cadence.mixed.deliveries; i++) {
    const raw = result.raw.tail[300 + i];
    assert.equal(raw.deliveryPhase, 'mixed', 'Mixed raw phase missing');
    assert.deepEqual(
      [raw.targetAt, raw.dispatchedAt, raw.browserDeliveredAt],
      [
        result.cadence.mixed.targetAt[i],
        result.cadence.mixed.dispatchedAt[i],
        result.cadence.mixed.actualAt[i],
      ],
      'Mixed raw delivery time differs from browser cadence',
    );
    assert.deepEqual(
      [raw.sequence, raw.kind, raw.sourceRowsBefore, raw.sourceRowsAfter],
      [i, 'replace', 100000, 100000],
      'Mixed tail role or source rows differ from workload',
    );
  }
  assert.ok(
    Array.isArray(result.cadence.mixed.pauses) &&
      result.cadence.mixed.pauses.every(
        (pause) =>
          typeof pause.kind === 'string' &&
          Number.isFinite(pause.started) &&
          Number.isFinite(pause.ended) &&
          pause.ended >= pause.started,
      ),
  );
  const pausesByDelivery = new Map();
  for (const pause of result.cadence.mixed.pauses) {
    assert.ok(
      Number.isInteger(pause.afterDelivery) &&
        pause.afterDelivery > 0 &&
        pause.afterDelivery <= result.cadence.mixed.deliveries &&
        Number.isFinite(pause.resetTargetAt) &&
        pause.resetTargetAt === pause.ended + 250,
      'Mixed pause reset evidence invalid',
    );
    assert.ok(
      pause.started >= result.cadence.mixed.actualAt[pause.afterDelivery - 1] &&
        ((pause.kind === 'add-remove' && pause.afterDelivery % 16 === 0) ||
          (pause.kind === 'remount' && pause.afterDelivery % 45 === 0) ||
          (pause.kind === 'checkpoint' && pause.afterDelivery % 40 === 0) ||
          ([
            'selection-hide-show',
            'lock',
            'style',
            'level',
            'text',
            'undo-redo',
            'save-restore',
            'market-isolation',
            'correction',
            'resize',
          ].includes(pause.kind) &&
            pause.afterDelivery % 34 === 0 &&
            result.lifecycle?.actions?.some(
              (item) => item.action === pause.kind && item.at === pause.started,
            ))),
      'Mixed pause lacks the corresponding lifecycle role',
    );
    const previous = pausesByDelivery.get(pause.afterDelivery);
    if (previous) assert.ok(pause.started >= previous.ended, 'Overlapping mixed pause records');
    pausesByDelivery.set(pause.afterDelivery, pause);
  }
  for (let i = 1; i < result.cadence.mixed.deliveries; i++) {
    const priorPause = pausesByDelivery.get(i);
    assert.equal(
      result.cadence.mixed.targetAt[i],
      priorPause?.resetTargetAt ?? result.cadence.mixed.targetAt[i - 1] + 250,
      'Mixed target schedule differs from 250 ms grid or recorded pause reset',
    );
  }
  assert.ok(Array.isArray(result.checkpoints) && result.checkpoints.length >= 12);
  const ids = new Set(result.checkpoints.map((checkpoint) => checkpoint.id));
  assert.equal(ids.size, result.checkpoints.length, 'Repeated checkpoint attempt identity');
  for (const id of [
    'mixed-initial',
    ...Array.from({ length: 11 }, (_, i) => 'mixed-' + (i + 1)),
    'mixed-before-workspace-restore',
    'mixed-after-workspace-restore',
    'mixed-final',
    'maximum-limits-32-levels-20-lines',
  ])
    assert.ok(ids.has(id), 'Named checkpoint missing: ' + id);
  const limitCheckpoint = result.checkpoints.find((item) => item.id === result.maximumLimits.checkpointId);
  assert.ok(
    limitCheckpoint.document.drawings.some(
      (item) => item.type === 'fibonacci-retracement' && item.levels?.length === 32,
    ) &&
      limitCheckpoint.document.drawings.some(
        (item) => item.type === 'text-note' && item.text.split('\n').length === 20,
      ),
    'Named maximum checkpoint lacks observed 32 Fibonacci levels and 20 note lines',
  );
  assert.ok(
    result.checkpoints.filter((checkpoint) => checkpoint.id.startsWith('mixed-') && checkpoint.full === true)
      .length >= 12,
    'Twelve full mixed checkpoints missing',
  );
  for (const checkpoint of result.checkpoints) {
    assert.equal(checkpoint.status, 'accepted', checkpoint.id + ': rejected checkpoint');
    assert.equal(checkpoint.document?.drawings?.length, 200, 'Full checkpoint requires all 200 drawings');
    const mix = Object.fromEntries(
      Object.keys(DRAWING_MIX).map((type) => [
        type,
        checkpoint.document.drawings.filter((d) => d.type === type).length,
      ]),
    );
    assert.deepEqual(mix, DRAWING_MIX);
    verifyDrawingCheckpoint(checkpoint);
  }
  assert.ok(result.lifecycle?.addRemoveCycles >= 25);
  assert.ok(result.lifecycle?.remounts >= 6);
  const actions = result.lifecycle.actions;
  assert.ok(Array.isArray(actions));
  for (const action of [
    'selection-hide-show',
    'lock',
    'style',
    'level',
    'text',
    'undo-redo',
    'save-restore',
    'market-isolation',
    'correction',
    'resize',
  ])
    assert.ok(
      actions.some((item) => item.action === action && actionProof(item)),
      'Verified semantic action missing: ' + action,
    );
  assert.ok(
    result.raw.wheel.every(
      (item) =>
        finiteRange(item.beforeRange) &&
        finiteRange(item.afterRange) &&
        (item.afterRange.from !== item.beforeRange.from || item.afterRange.to !== item.beforeRange.to),
    ),
    'Wheel record has no effective visible-range change',
  );
  const r = result.resources;
  assert.equal(r?.protocol, 'authored-structural-weakref-v1');
  assert.equal(r.gcTurns, 3);
  assert.equal(r.baselineDrawings, 200);
  assert.equal(r.finalDrawings, 200);
  for (const phase of ['baseline', 'final']) {
    const release = r.fixtureCallbackRelease?.[phase];
    assert.equal(release?.phase, phase, phase + ': fixture callback release phase missing');
    assert.equal(release.status, 'accepted', phase + ': fixture callback release failed');
    assert.equal(release.callbackPresent, true, phase + ': obsolete callback missing');
    assert.match(release.beforeHtmlSha256, /^[a-f0-9]{64}$/, phase + ': active HTML hash missing');
    assert.equal(release.afterHtmlSha256, release.beforeHtmlSha256, phase + ': active HTML changed');
    for (const field of [
      'requests',
      'activeRequests',
      'subscriptions',
      'deliveries',
      'generation',
      'canvases',
    ])
      assert.ok(
        Number.isSafeInteger(release.beforeCounts?.[field]) && release.beforeCounts[field] >= 0,
        phase + ': fixture count missing: ' + field,
      );
    assert.equal(typeof release.beforeCounts?.gated, 'boolean', phase + ': fixture gate missing');
    assert.deepEqual(release.afterCounts, release.beforeCounts, phase + ': active fixture counts changed');
    assert.equal(release.secondDelivery, null, phase + ': fixture callback was not drained');
  }
  assert.deepEqual(r.finalState, r.baselineState, 'Resource endpoint states differ');
  assert.equal(r.baselineState?.editorClosed, true);
  assert.equal(r.baselineState?.selectedId, null);
  assert.deepEqual(r.baselineState?.market, { symbol: 'BTCUSDT', interval: '1m' });
  assert.deepEqual([r.baselineState?.rows, r.baselineState?.series, r.baselineState?.panes], [100000, 12, 4]);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(DRAWING_MIX).map((type) => [
        type,
        r.baselineState?.document?.drawings?.filter((item) => item.type === type).length,
      ]),
    ),
    DRAWING_MIX,
    'Resource endpoint drawing composition differs from reference',
  );
  for (const field of [
    'growth',
    'terminalGrowth',
    'listenerGrowth',
    'retainedHeapDelta',
    'outside',
    'detached',
    'disposed',
  ])
    assert.ok(Number.isFinite(r[field]), field + ': nonfinite resource metric');
  assert.ok(
    r.growth <= 0 &&
      r.terminalGrowth <= 0 &&
      r.listenerGrowth <= 0 &&
      r.retainedHeapDelta <= 12 * 1024 * 1024,
  );
  for (const field of [
    'outside',
    'detached',
    'disposed',
    'obsoleteImmediateMutations',
    'obsoleteDelayedMutations',
  ])
    assert.equal(r[field], 0, field);
  assert.equal(r.secondDelivery, null);
  for (const field of ['canvases', 'subscriptions', 'requests'])
    assert.equal(result.cleanup?.[field], 0, field);
  assert.equal(result.cleanup.browserClosed, true);
  assert.equal(result.cleanup.serverClosed, true);
  return summary;
}
