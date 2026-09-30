import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve('dist/public-demo');
const pages = ['analysis.html', 'drawings.html', 'index.html', 'market.html', 'terminal.html'];

function inventory(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, `No symlink: ${name}`);
    return stat.isDirectory() ? inventory(path) : [path];
  });
}

test('public artifact contains only five demo pages and their assets', () => {
  assert.deepEqual(
    readdirSync(root)
      .filter((name) => name.endsWith('.html'))
      .sort(),
    pages,
  );
  assert.deepEqual(
    readdirSync(root)
      .filter((name) => lstatSync(resolve(root, name)).isDirectory())
      .sort(),
    ['assets', 'brand'],
  );
  for (const path of inventory(root)) {
    assert.ok(['.html', '.js', '.css', '.svg'].includes(extname(path)), path);
    assert.doesNotMatch(path.slice(root.length), /benchmark|test\.html|test-results|\.map$/i);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /__FILTIX_VERSION__|[A-Z]:[/\\](?:Users|AI)[/\\]/i);
  }
});

test('public HTML uses portable links with no excluded routes', () => {
  for (const page of pages) {
    const html = readFileSync(resolve(root, page), 'utf8');
    assert.match(html, /FILTRIX/);
    assert.doesNotMatch(html, /data-development-only|href=["'][^"']*benchmark/i);
    for (const [, value] of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      if (/^(?:https?:|data:|#)/.test(value)) continue;
      assert.ok(!value.startsWith('/'), `${page}: root-absolute ${value}`);
      const pathname = new URL(value, 'https://demo.invalid/filtix-charts/').pathname;
      assert.ok(pathname.startsWith('/filtix-charts/'), `${page}: escapes prefix ${value}`);
      const local = resolve(
        root,
        decodeURIComponent(pathname.slice('/filtix-charts/'.length)) || 'index.html',
      );
      assert.ok(local.startsWith(root + sep), `${page}: escapes output ${value}`);
      assert.ok(existsSync(local), `${page}: missing ${value}`);
    }
    for (const [, href] of html.matchAll(/href="(https:\/\/filtrix\.net\/[^"\s]*)"/g)) {
      const url = new URL(href.replaceAll('&amp;', '&'));
      assert.equal(url.searchParams.get('utm_campaign'), 'open_beta');
    }
  }
});
