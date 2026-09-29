import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

test('benchmark empty baseline releases the ordinary demo fixture retained late callback', async () => {
  const source = readFileSync(
    new URL('../../examples/react-terminal/src/grid-test.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function prepareEmpty() {');
  const end = source.indexOf('function resources(label) {', start);
  assert.ok(start >= 0 && end > start, 'benchmark empty-baseline teardown must be present');
  const teardown = source.slice(start, end);
  const unmount = teardown.indexOf('window.gridHarness.unmount()');
  const clear = teardown.indexOf('fixture.clearFaults()');
  const baseline = teardown.indexOf("resources('prepared-empty-baseline')");
  assert.ok(unmount >= 0 && clear > unmount && baseline > clear);

  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('/fixture-provider.ts'))
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
  });
  let createFixtureProvider;
  try {
    ({ createFixtureProvider } = await import('../../examples/react-terminal/src/fixture-provider.ts'));
  } finally {
    hooks.deregister();
  }
  const query = { symbol: 'BTCUSDT', interval: '1m' };
  const handlers = { onOpen() {}, onBar() {}, onError() {}, onClose() {} };
  const control = createFixtureProvider();
  control.provider.subscribe(query, handlers)();
  assert.equal(control.stats().activeSubscriptions, 0);
  assert.deepEqual(control.deliverLate()?.query, query, 'normal unsubscribe retains a late callback');

  const cleaned = createFixtureProvider();
  cleaned.provider.subscribe(query, handlers)();
  assert.equal(cleaned.stats().activeSubscriptions, 0);
  assert.equal(cleaned.stats().activeRequests, 0);
  cleaned.clearFaults();
  assert.equal(cleaned.deliverLate(), null, 'benchmark teardown releases the retained callback');
});
