import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { buildGridScene } from '../../scripts/grid-oracle.mjs';

test('capacity fixture admits 400 rules across 32 exact queries through the real grid decoder', async () => {
  const runner = readFileSync(new URL('../../scripts/grid-benchmark.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('function capacitySceneFor(scene) {');
  const end = runner.indexOf('async function capacityPhase(scene) {');
  assert.ok(start >= 0 && end > start, 'runner must expose its exact pure capacity scene builder');
  const build = new Function('clone', `${runner.slice(start, end)}\nreturn capacitySceneFor;`)(
    structuredClone,
  );
  const { capacityScene, queries } = build(buildGridScene({ rowsPerCell: 256 }));
  assert.equal(queries.length, 32);
  assert.equal(new Set(queries.map((query) => JSON.stringify([query.symbol, query.interval]))).size, 32);
  assert.equal(capacityScene.catalog.symbols.length * capacityScene.catalog.intervals.length, 32);
  assert.ok(
    capacityScene.cells.every(
      (cell) =>
        capacityScene.catalog.symbols.includes(cell.query.symbol) &&
        capacityScene.catalog.intervals.includes(cell.query.interval),
    ),
  );
  assert.ok(capacityScene.cells.every((cell) => cell.alerts.alerts.length === 100));
  assert.equal(capacityScene.monitorSources.length, 32);
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.ts') && url.includes('/packages/'))
        return {
          format: 'module',
          source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
            mode: 'transform',
            sourceUrl: url,
          }),
          shortCircuit: true,
        };
      return nextLoad(url, context);
    },
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@filtrix.net/')) {
        const [name, subpath] = specifier.slice('@filtrix.net/'.length).split('/');
        return nextResolve(
          new URL(`../../packages/${name}/src/${subpath ?? 'index'}.ts`, import.meta.url).href,
          context,
        );
      }
      if (specifier.startsWith('.') && context.parentURL?.includes('/packages/')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  let decodeGridWorkspace, resolveCatalog;
  try {
    ({ decodeGridWorkspace } = await import('../../packages/terminal/src/grid-codec.ts'));
    ({ resolveCatalog } = await import('../../packages/terminal/src/codec.ts'));
  } finally {
    hooks.deregister();
  }
  const context = {
    providerId: capacityScene.gridWorkspace.providerId,
    symbols: capacityScene.catalog.symbols,
    intervals: capacityScene.catalog.intervals,
    legacyAlertScopeIds: Object.fromEntries(
      capacityScene.cells.map((cell) => [cell.id, cell.alerts.scopeId]),
    ),
  };
  assert.deepEqual(
    resolveCatalog(capacityScene.cells[0].query, context.symbols, context.intervals),
    capacityScene.catalog,
  );
  assert.deepEqual(decodeGridWorkspace(capacityScene.gridWorkspace, context), capacityScene.gridWorkspace);
  const outside = structuredClone(capacityScene.gridWorkspace);
  outside.cells[0].workspace.alerts.alerts[0].query = { symbol: 'CAP33', interval: '1m' };
  assert.throws(() => decodeGridWorkspace(outside, context), /outside.*catalog/i);
  const extraRule = structuredClone(capacityScene.gridWorkspace);
  extraRule.cells[0].workspace.alerts.alerts.push({
    ...extraRule.cells[0].workspace.alerts.alerts[0],
    id: `${extraRule.cells[0].workspace.alerts.scopeId}:101`,
  });
  extraRule.cells[0].workspace.alerts.nextRuleId = 102;
  assert.throws(() => decodeGridWorkspace(extraRule, context), /100|400|rule/i);
});
