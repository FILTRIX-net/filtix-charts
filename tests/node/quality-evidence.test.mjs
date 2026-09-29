import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConsumerCohort, releaseStage } from '../../scripts/consumer-identity.mjs';
import * as qualityEvidence from '../../scripts/quality-evidence.mjs';
import { assertFullCheckpoints, assertThreeEngineEvidence } from '../../scripts/quality-evidence.mjs';

const makeSample = (full) => ({ full, rows: 600, checkedRenderedPoints: full ? 600 : 5 });

function engineSnapshot(engine) {
  const bars = Array.from({ length: 36 }, (_, index) => ({
    time: 1_000 + index,
    open: 9,
    high: 12,
    low: 8,
    close: 10,
    volume: 100,
  }));
  const indices = [18, 19, 24, 25, 32, 33, 34, 35];
  return {
    engine,
    snapshot: {
      bars,
      studies: [{ id: 'study-1', kind: 'ema', period: 2, visible: true }],
      state: { settings: { volume: false } },
      rendered: indices.map((index) => ({
        index,
        time: bars[index].time,
        points: {
          'terminal-price': { ...bars[index] },
          'terminal-study-1': { time: bars[index].time, value: 10 },
        },
      })),
    },
  };
}

test('eleven full checkpoints fail even with many sampled checkpoints', () => {
  const samples = [
    ...Array.from({ length: 11 }, () => makeSample(true)),
    ...Array.from({ length: 30 }, () => makeSample(false)),
  ];
  assert.throws(() => assertFullCheckpoints(samples), /12 full/i);
});

test('twelve full checkpoints pass the independent full gate', () => {
  const samples = Array.from({ length: 12 }, () => makeSample(true));
  assert.equal(assertFullCheckpoints(samples).length, 12);
  samples[11].checkedRenderedPoints = 5;
  assert.throws(() => assertFullCheckpoints(samples), /every row/i);
});

test('three installed engines retain coherent eight point payloads', () => {
  const records = ['chromium', 'firefox', 'webkit'].map(engineSnapshot);
  assert.equal(assertThreeEngineEvidence(records), 24);
});

test('missing and tampered engine payloads fail independent recalculation', () => {
  const records = ['chromium', 'firefox', 'webkit'].map(engineSnapshot);
  const missing = structuredClone(records);
  missing[1].snapshot.rendered[3].points['terminal-study-1'] = undefined;
  assert.throws(() => assertThreeEngineEvidence(missing), /missing point/i);
  const tampered = structuredClone(records);
  tampered[2].snapshot.rendered[5].points['terminal-study-1'].value = 11;
  assert.throws(() => assertThreeEngineEvidence(tampered), /diverged/i);
  const absentSource = structuredClone(records);
  delete absentSource[0].snapshot.bars;
  assert.throws(() => assertThreeEngineEvidence(absentSource), /bars/i);
  const absentStudy = structuredClone(records);
  delete absentStudy[0].snapshot.studies;
  assert.throws(() => assertThreeEngineEvidence(absentStudy), /studies/i);
  const wrongSource = structuredClone(records);
  wrongSource[0].snapshot.bars[18].close = 11;
  assert.throws(() => assertThreeEngineEvidence(wrongSource), /price.close/i);
  const wrongStudy = structuredClone(records);
  wrongStudy[0].snapshot.studies[0].period = 40;
  assert.throws(() => assertThreeEngineEvidence(wrongStudy), /warmup/i);
  const omittedSample = structuredClone(records);
  omittedSample[0].snapshot.rendered.pop();
  assert.throws(() => assertThreeEngineEvidence(omittedSample), /eight sampled indices/i);
});

test('exact supported cohort and patch stage derivation', () => {
  assert.equal(resolveConsumerCohort('v0.8.1', '0.8.1'), '0.8.1');
  assert.equal(releaseStage('0.6.0'), 'v0.6');
  assert.equal(releaseStage('0.7.0'), 'v0.7');
  assert.equal(releaseStage('0.8.0'), 'v0.8');
  assert.equal(releaseStage('0.8.1'), 'v0.8.1');
  assert.throws(() => resolveConsumerCohort('v0.8', '0.8.1'));
  assert.throws(() => resolveConsumerCohort('v0.8.1', '0.8.0'));
  assert.throws(() => releaseStage('0.8.2'));
  assert.throws(() => releaseStage('0.9.1'));
});

test('maximum dispatch cadence excludes the pause between phases', () => {
  const dispatches = [
    { phase: 'replacements', dispatchedAt: 1000 },
    { phase: 'replacements', dispatchedAt: 1100 },
    { phase: 'replacements', dispatchedAt: 1210 },
    { phase: 'append-and-replace', dispatchedAt: 10000 },
    { phase: 'append-and-replace', dispatchedAt: 10120 },
    { phase: 'append-and-replace', dispatchedAt: 10240 },
  ];
  const cadence = qualityEvidence.summarizeDispatchCadence(dispatches);
  assert.equal(cadence.targetIntervalMs, 100);
  assert.equal(cadence.targetHz, 10);
  assert.equal(cadence.denominator, 'within-phase gaps between consecutive dispatch starts');
  assert.deepEqual(cadence.phases[0].gapsMs, [100, 110]);
  assert.deepEqual(cadence.phases[1].gapsMs, [120, 120]);
  assert.equal(cadence.phases[0].intervalCount, 2);
  assert.equal(cadence.phases[1].intervalCount, 2);
  assert.equal(cadence.phases[0].observedMeanIntervalMs, 105);
  assert.equal(cadence.phases[1].observedMeanIntervalMs, 120);
  assert.ok(Math.abs(cadence.phases[0].observedHz - 1000 / 105) < 1e-12);
  assert.ok(Math.abs(cadence.phases[1].observedHz - 1000 / 120) < 1e-12);
});
