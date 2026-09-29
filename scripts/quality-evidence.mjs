import assert from 'node:assert/strict';
import { stats, verifyRendered } from './multi-output-oracle.mjs';

export function summarizeDispatchCadence(dispatches) {
  assert.ok(Array.isArray(dispatches) && dispatches.length > 0, 'Dispatch timestamps required');
  const phases = [];
  for (const dispatch of dispatches) {
    assert.ok(typeof dispatch.phase === 'string' && dispatch.phase, 'Dispatch phase required');
    assert.ok(Number.isFinite(dispatch.dispatchedAt), 'Finite dispatch start required');
    let phase = phases.at(-1);
    if (phase?.phase !== dispatch.phase) {
      assert.ok(!phases.some((item) => item.phase === dispatch.phase), 'Dispatch phase must be contiguous');
      phase = { phase: dispatch.phase, dispatchedAt: [] };
      phases.push(phase);
    }
    phase.dispatchedAt.push(dispatch.dispatchedAt);
  }
  return {
    targetIntervalMs: 100,
    targetHz: 10,
    denominator: 'within-phase gaps between consecutive dispatch starts',
    phases: phases.map(({ phase, dispatchedAt }) => {
      assert.ok(dispatchedAt.length >= 2, phase + ': two dispatches required for cadence');
      const gapsMs = dispatchedAt.slice(1).map((time, index) => time - dispatchedAt[index]);
      assert.ok(
        gapsMs.every((gap) => gap > 0),
        phase + ': increasing dispatch starts',
      );
      const intervalCount = gapsMs.length;
      const elapsedMs = dispatchedAt.at(-1) - dispatchedAt[0];
      return {
        phase,
        dispatches: dispatchedAt.length,
        intervalCount,
        firstDispatchedAt: dispatchedAt[0],
        lastDispatchedAt: dispatchedAt.at(-1),
        elapsedMs,
        gapsMs,
        gapStatsMs: stats(gapsMs),
        observedMeanIntervalMs: elapsedMs / intervalCount,
        observedHz: (intervalCount * 1000) / elapsedMs,
      };
    }),
  };
}

export function assertFullCheckpoints(samples) {
  assert.ok(Array.isArray(samples), 'Mixed session samples are required');
  const full = samples.filter((sample) => sample.full === true);
  assert.ok(full.length >= 12, 'Mixed session requires at least 12 full checkpoints');
  for (const sample of full) {
    assert.ok(sample.rows >= 500 && sample.rows <= 750, 'Full checkpoint row range');
    assert.equal(sample.checkedRenderedPoints, sample.rows, 'Full checkpoint checks every row');
  }
  return full;
}

export function assertThreeEngineEvidence(records) {
  assert.ok(Array.isArray(records), 'Three engine records are required');
  assert.deepEqual(
    records.map((record) => record.engine).sort(),
    ['chromium', 'firefox', 'webkit'],
    'Exact installed engine cohort',
  );
  let points = 0;
  for (const { engine, snapshot } of records) {
    assert.ok(snapshot && typeof snapshot === 'object', engine + ': coherent snapshot required');
    assert.ok(Array.isArray(snapshot.bars) && snapshot.bars.length >= 36, engine + ': bars required');
    assert.ok(Array.isArray(snapshot.studies), engine + ': studies required');
    assert.ok(Array.isArray(snapshot.rendered), engine + ': rendered payload required');
    assert.deepEqual(
      snapshot.rendered.map((sample) => sample.index),
      [18, 19, 24, 25, 32, 33, snapshot.bars.length - 2, snapshot.bars.length - 1],
      engine + ': exact eight sampled indices',
    );
    points += verifyRendered(snapshot, engine + ' retained evidence');
  }
  return points;
}
