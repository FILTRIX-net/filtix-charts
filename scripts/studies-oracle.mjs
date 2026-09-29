// Independent acceptance mathematics; never imports production indicators.
import assert from 'node:assert/strict';
export function baseline(bars, study) {
  const values = bars.map((bar) => bar.close),
    period = study.period;
  const result = Array(values.length).fill(null);
  if (study.kind === 'sma') {
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      result[i] = sum / period;
    }
  } else if (study.kind === 'ema') {
    let current;
    for (let i = period - 1; i < values.length; i++) {
      current =
        i === period - 1
          ? values.slice(0, period).reduce((a, b) => a + b, 0) / period
          : current + (values[i] - current) * (2 / (period + 1));
      result[i] = current;
    }
  } else if (study.kind === 'rsi') {
    let gain = 0,
      loss = 0;
    for (let i = 1; i < values.length; i++) {
      const delta = values[i] - values[i - 1];
      if (i <= period) {
        gain += Math.max(0, delta) / period;
        loss += Math.max(0, -delta) / period;
      } else {
        gain = (gain * (period - 1) + Math.max(0, delta)) / period;
        loss = (loss * (period - 1) + Math.max(0, -delta)) / period;
      }
      if (i >= period) result[i] = gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
    }
  } else throw Error('Unsupported oracle kind');
  return result;
}
export function verifyRendered(snapshot, label) {
  const { bars, rendered, studies } = snapshot;
  const panes = snapshot.panes ?? snapshot.projection?.panes;
  if (panes) {
    const oscillatorIds = studies
      .filter((study) => study.visible && study.kind === 'rsi')
      .map((study) => 'terminal-' + study.id + '-pane');
    const expectedIds = [
      'price',
      ...(snapshot.state.settings.volume ? ['terminal-volume-pane'] : []),
      ...oscillatorIds,
    ];
    assert.deepEqual(
      panes.map((pane) => pane.id).sort(),
      [...expectedIds].sort(),
      label + ': exact owned panes',
    );
    assert.deepEqual(
      panes.filter((pane) => oscillatorIds.includes(pane.id)).map((pane) => pane.id),
      oscillatorIds,
      label + ': RSI pane order',
    );
    for (const pane of panes.filter((pane) => oscillatorIds.includes(pane.id)))
      assert.equal(pane.scale, 'linear', label + ': RSI linear scale');
  }
  const expected = new Map(
    studies.filter((s) => s.visible).map((study) => [study.id, baseline(bars, study)]),
  );
  for (const observation of rendered) {
    const bar = bars[observation.index];
    assert.equal(observation.time, bar.time, label + ': rendered timestamp');
    for (const field of ['time', 'open', 'high', 'low', 'close', 'volume'])
      assert.equal(observation.points['terminal-price']?.[field], bar[field], label + ': price.' + field);
    if (snapshot.state.settings.volume)
      assert.equal(observation.points['terminal-volume']?.value, bar.volume, label + ': volume');
    if (snapshot.state.settings.volume)
      assert.equal(observation.points['terminal-volume']?.time, bar.time, label + ': volume timestamp');
    const allowed = new Set([
      'terminal-price',
      ...(snapshot.state.settings.volume ? ['terminal-volume'] : []),
    ]);
    for (const study of studies) {
      const id = study.id === 'terminal-ema' ? study.id : 'terminal-' + study.id;
      if (!study.visible) {
        assert.equal(observation.points[id], undefined, label + ': hidden series');
        continue;
      }
      allowed.add(id);
      const want = expected.get(study.id)[observation.index];
      const got = observation.points[id];
      if (got != null) assert.equal(got.time, bar.time, label + ': study point timestamp');
      if (want === null) assert.ok(got == null || got.value === undefined, label + ': warmup');
      else {
        assert.ok(Number.isFinite(got?.value), label + ': finite study value');
        assert.ok(
          Math.abs(got.value - want) <= Math.max(1e-9, Math.abs(want) * 1e-12),
          label + ': ' + study.id + ' diverged: ' + got.value + ' vs ' + want,
        );
      }
    }
    for (const id of Object.keys(observation.points))
      assert.ok(allowed.has(id), label + ': orphan series ' + id);
  }
  return rendered.length;
}
export function stats(values) {
  assert.ok(values.length > 0, 'Expected nonempty timing sample');
  for (const value of values) assert.ok(Number.isFinite(value) && value >= 0, 'Finite timing');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { samples: values.length, median: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: sorted.at(-1) };
}
