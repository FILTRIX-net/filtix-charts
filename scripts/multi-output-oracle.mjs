// Independent acceptance mathematics. This module never imports production indicators.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const OUTPUTS = Object.freeze({
  macd: Object.freeze(['macd', 'signal', 'histogram']),
  bollinger: Object.freeze(['middle', 'upper', 'lower', 'fill']),
});

function closeValues(bars) {
  return bars.map((bar) => (bar && Number.isFinite(bar.close) ? bar.close : null));
}

export function seededEma(values, period) {
  const output = Array(values.length).fill(null);
  const seed = [];
  const alpha = 2 / (period + 1);
  let current = null;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      seed.length = 0;
      current = null;
      continue;
    }
    if (current === null) {
      seed.push(value);
      if (seed.length < period) continue;
      current = seed.reduce((sum, item) => sum + item, 0) / period;
    } else {
      current += (value - current) * alpha;
    }
    output[index] = current;
  }
  return output;
}

function sma(values, period) {
  const output = Array(values.length).fill(null);
  const window = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      window.length = 0;
      continue;
    }
    window.push(value);
    if (window.length > period) window.shift();
    if (window.length === period) output[index] = window.reduce((sum, item) => sum + item, 0) / period;
  }
  return output;
}

function rsi(values, period) {
  const output = Array(values.length).fill(null);
  let previous = null;
  let changes = 0;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      previous = null;
      changes = 0;
      averageGain = 0;
      averageLoss = 0;
      continue;
    }
    if (previous === null) {
      previous = value;
      continue;
    }
    const delta = value - previous;
    previous = value;
    const gain = Math.max(0, delta);
    const loss = Math.max(0, -delta);
    if (changes < period) {
      averageGain += gain / period;
      averageLoss += loss / period;
      changes++;
      if (changes < period) continue;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    output[index] = averageGain + averageLoss === 0 ? 50 : (100 * averageGain) / (averageGain + averageLoss);
  }
  return output;
}

export function macdOracle(values, fastPeriod, slowPeriod, signalPeriod) {
  const fast = seededEma(values, fastPeriod);
  const slow = seededEma(values, slowPeriod);
  const macd = values.map((_, index) =>
    fast[index] === null || slow[index] === null ? null : fast[index] - slow[index],
  );
  const signal = seededEma(macd, signalPeriod);
  const histogram = macd.map((value, index) =>
    value === null || signal[index] === null ? null : value - signal[index],
  );
  return { macd, signal, histogram };
}

export function bollingerOracle(values, period, multiplier) {
  const output = Array(values.length).fill(null);
  const window = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      window.length = 0;
      continue;
    }
    window.push(value);
    if (window.length > period) window.shift();
    if (window.length < period) continue;
    const middle = window.reduce((sum, item) => sum + item, 0) / period;
    const variance = window.reduce((sum, item) => sum + (item - middle) ** 2, 0) / period;
    const spread = multiplier * Math.sqrt(variance);
    output[index] = {
      middle,
      upper: middle + spread,
      lower: middle - spread,
    };
  }
  return output;
}

export function studySeriesIds(study) {
  if (study.kind === 'macd') return OUTPUTS.macd.map((output) => `terminal-${study.id}-${output}`);
  if (study.kind === 'bollinger') return OUTPUTS.bollinger.map((output) => `terminal-${study.id}-${output}`);
  return [study.id === 'terminal-ema' ? study.id : `terminal-${study.id}`];
}

export function expectedStudyOutputs(bars, study) {
  const values = closeValues(bars);
  if (study.kind === 'macd')
    return macdOracle(values, study.fastPeriod, study.slowPeriod, study.signalPeriod);
  if (study.kind === 'bollinger') {
    const bands = bollingerOracle(values, study.period, study.multiplier);
    return {
      middle: bands.map((point) => point?.middle ?? null),
      upper: bands.map((point) => point?.upper ?? null),
      lower: bands.map((point) => point?.lower ?? null),
      fill: bands,
    };
  }
  if (study.kind === 'sma') return { value: sma(values, study.period) };
  if (study.kind === 'ema') return { value: seededEma(values, study.period) };
  if (study.kind === 'rsi') return { value: rsi(values, study.period) };
  throw new Error(`Unsupported oracle kind: ${study.kind}`);
}

function closeEnough(actual, expected, label) {
  assert.ok(Number.isFinite(actual), `${label}: finite value`);
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-12);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} diverged from ${expected}`);
}

function assertValuePoint(point, expected, time, label) {
  if (expected === null) {
    assert.ok(point == null || point.value === undefined, `${label}: warmup/whitespace`);
    return;
  }
  assert.ok(point != null, `${label}: missing point`);
  assert.equal(point.time, time, `${label}: timestamp`);
  closeEnough(point.value, expected, label);
}

function assertBandPoint(point, expected, time, label) {
  if (expected === null) {
    assert.ok(
      point == null || (point.upper === undefined && point.lower === undefined),
      `${label}: warmup/whitespace`,
    );
    return;
  }
  assert.ok(point != null, `${label}: missing point`);
  assert.equal(point.time, time, `${label}: timestamp`);
  closeEnough(point.upper, expected.upper, `${label}.upper`);
  closeEnough(point.lower, expected.lower, `${label}.lower`);
}

function verifyPanes(snapshot, label) {
  const panes = snapshot.panes ?? snapshot.projection?.panes;
  if (!panes) return;
  const oscillatorStudies = snapshot.studies.filter(
    (study) => study.visible && (study.kind === 'rsi' || study.kind === 'macd'),
  );
  const expectedIds = [
    'price',
    ...(snapshot.state.settings.volume ? ['terminal-volume-pane'] : []),
    ...oscillatorStudies.map((study) => `terminal-${study.id}-pane`),
  ];
  assert.deepEqual(
    panes.map((pane) => pane.id),
    expectedIds,
    `${label}: exact pane order`,
  );
  for (const pane of panes.slice(expectedIds.length - oscillatorStudies.length))
    assert.equal(pane.scale, 'linear', `${label}: oscillator pane scale`);
}

export function verifyRendered(snapshot, label = 'rendered') {
  const { bars, rendered, studies } = snapshot;
  assert.ok(Array.isArray(bars), `${label}: bars`);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${label}: rendered samples`);
  assert.ok(Array.isArray(studies), `${label}: studies`);
  verifyPanes(snapshot, label);

  const expected = new Map(studies.map((study) => [study.id, expectedStudyOutputs(bars, study)]));
  const visibleIds = new Set([
    'terminal-price',
    ...(snapshot.state.settings.volume ? ['terminal-volume'] : []),
    ...studies.filter((study) => study.visible).flatMap(studySeriesIds),
  ]);

  for (const observation of rendered) {
    const bar = bars[observation.index];
    assert.ok(bar, `${label}: sample index ${observation.index}`);
    assert.equal(observation.time, bar.time, `${label}: rendered timestamp`);
    const price = observation.points['terminal-price'];
    assert.ok(price, `${label}: price point`);
    for (const field of ['time', 'open', 'high', 'low', 'close', 'volume'])
      assert.equal(price[field], bar[field], `${label}: price.${field}`);
    if (snapshot.state.settings.volume) {
      const volume = observation.points['terminal-volume'];
      assert.ok(volume, `${label}: volume point`);
      assert.equal(volume.time, bar.time, `${label}: volume timestamp`);
      assert.equal(volume.value, bar.volume, `${label}: volume value`);
    }

    assert.deepEqual(
      Object.keys(observation.points).sort(),
      [...visibleIds].sort(),
      `${label}: exact visible output IDs`,
    );

    for (const study of studies) {
      const ids = studySeriesIds(study);
      if (!study.visible) {
        for (const id of ids)
          assert.equal(observation.points[id], undefined, `${label}: hidden series ${id}`);
        continue;
      }
      const outputs = expected.get(study.id);
      if (study.kind === 'macd') {
        for (const output of OUTPUTS.macd)
          assertValuePoint(
            observation.points[`terminal-${study.id}-${output}`],
            outputs[output][observation.index],
            bar.time,
            `${label}: ${study.id}.${output}`,
          );
      } else if (study.kind === 'bollinger') {
        for (const output of ['middle', 'upper', 'lower'])
          assertValuePoint(
            observation.points[`terminal-${study.id}-${output}`],
            outputs[output][observation.index],
            bar.time,
            `${label}: ${study.id}.${output}`,
          );
        assertBandPoint(
          observation.points[`terminal-${study.id}-fill`],
          outputs.fill[observation.index],
          bar.time,
          `${label}: ${study.id}.fill`,
        );
      } else {
        assertValuePoint(
          observation.points[ids[0]],
          outputs.value[observation.index],
          bar.time,
          `${label}: ${study.id}.value`,
        );
      }
    }
    for (const id of Object.keys(observation.points))
      assert.ok(visibleIds.has(id), `${label}: orphan series ${id}`);
  }
  return rendered.length;
}

export function stats(values) {
  assert.ok(values.length > 0, 'Expected nonempty timing sample');
  for (const value of values)
    assert.ok(Number.isFinite(value) && value >= 0, 'Expected finite nonnegative timing');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile) => sorted[Math.ceil(sorted.length * percentile) - 1];
  return {
    samples: values.length,
    median: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1),
  };
}

function syntheticSnapshot() {
  const bars = Array.from({ length: 8 }, (_, index) => ({
    time: index + 1,
    open: 10 + index,
    high: 12 + index,
    low: 9 + index,
    close: 11 + index,
    volume: 100 + index,
  }));
  const studies = [
    { id: 'study-1', kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2, visible: true },
    { id: 'study-2', kind: 'bollinger', period: 3, multiplier: 2, visible: true },
    { id: 'study-3', kind: 'ema', period: 2, visible: false },
  ];
  const expected = new Map(studies.map((study) => [study.id, expectedStudyOutputs(bars, study)]));
  const rendered = bars.map((bar, index) => {
    const points = {
      'terminal-price': { ...bar },
      'terminal-volume': { time: bar.time, value: bar.volume },
    };
    for (const output of OUTPUTS.macd) {
      const value = expected.get('study-1')[output][index];
      points[`terminal-study-1-${output}`] = value === null ? null : { time: bar.time, value };
    }
    const band = expected.get('study-2').fill[index];
    for (const output of ['middle', 'upper', 'lower']) {
      const value = expected.get('study-2')[output][index];
      points[`terminal-study-2-${output}`] = value === null ? null : { time: bar.time, value };
    }
    points['terminal-study-2-fill'] = band === null ? null : { time: bar.time, ...band };
    return { index, time: bar.time, points };
  });
  return {
    bars,
    studies,
    rendered,
    state: { settings: { volume: true } },
    panes: [
      { id: 'price', scale: 'log' },
      { id: 'terminal-volume-pane', scale: 'linear' },
      { id: 'terminal-study-1-pane', scale: 'linear' },
    ],
  };
}

export function selfTest() {
  assert.deepEqual(seededEma([1, 2, null, 10, 12], 2), [null, 1.5, null, null, 11]);
  const fixedMacd = macdOracle([1, 2, 3, 4, 5, 6], 2, 3, 2);
  assert.deepEqual(fixedMacd.macd, [null, null, 0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(fixedMacd.signal, [null, null, null, 0.5, 0.5, 0.5]);
  assert.deepEqual(fixedMacd.histogram, [null, null, null, 0, 0, 0]);
  const fixedBand = bollingerOracle([1, 2, 3], 3, 2).at(-1);
  assert.equal(fixedBand.middle, 2);
  closeEnough(fixedBand.upper, 2 + 2 * Math.sqrt(2 / 3), 'fixed BB upper');
  closeEnough(fixedBand.lower, 2 - 2 * Math.sqrt(2 / 3), 'fixed BB lower');
  const snapshot = syntheticSnapshot();
  assert.equal(verifyRendered(snapshot, 'self-test control'), snapshot.bars.length);
  const wrong = structuredClone(snapshot);
  const ready = wrong.rendered.find(
    (observation) => observation.points['terminal-study-1-signal']?.value !== undefined,
  );
  ready.points['terminal-study-1-signal'].value += 1;
  assert.throws(
    () => verifyRendered(wrong, 'intentional wrong-value probe'),
    /diverged/,
    'Independent oracle must reject an intentionally wrong rendered value',
  );
  return { result: 'pass', checked: snapshot.bars.length, negativeProbe: 'rejected wrong MACD signal' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(selfTest())}\n`);
