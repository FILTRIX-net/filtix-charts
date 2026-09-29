import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findNpmCli } from './npm-cli.mjs';
import { fileURLToPath } from 'node:url';
import {
  sourceIdentity,
  treeFiles,
  identities,
  releaseStage,
  expectedPackageMembers,
  expectedPackageNames,
} from './consumer-identity.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = resolve(root, 'examples/react-terminal');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const stage = releaseStage(version);
const offlineArgs = stage === 'v0.12-beta.1' ? [] : ['--offline'];
const npmCli = findNpmCli();
const run = (args, directory = cwd) => {
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  process.stdout.write(result.stdout);
};
const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
assert.equal(manifest.private, true);
assert.equal(manifest.workspaces, undefined);
const packages = expectedPackageNames(stage);
const archives = packages.map((name) => {
  const archive = resolve(root, 'dist/packages/filtix-' + name + '-' + version + '.tgz');
  const bytes = readFileSync(archive);
  return {
    name: '@filtix/' + name,
    path: archive,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
});
run([
  npmCli,
  'exec',
  '--yes',
  ...offlineArgs,
  '--cache',
  resolve(root, '.npm-cache'),
  '--package=npm@12.0.2',
  '--',
  'npm',
  'install',
  ...offlineArgs,
  '--ignore-scripts',
  '--cache',
  resolve(root, '.npm-cache'),
  '--no-audit',
  '--no-fund',
  ...archives.map((item) => item.path),
]);
for (const archive of archives) {
  const { name } = archive;
  const installed = resolve(cwd, 'node_modules', name);
  assert.equal(
    realpathSync(installed).toLowerCase(),
    installed.toLowerCase(),
    'Consumer package must be copied from archive, not a workspace symlink',
  );
  const tar = gunzipSync(readFileSync(archive.path));
  const members = [];
  const expectedMembers = expectedPackageMembers(stage, name).map((path) => 'package/' + path);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    if (!path) break;
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    assert.ok(expectedMembers.includes(path), 'Unexpected archive member: ' + path);
    const installedBytes = readFileSync(resolve(installed, path.slice(8)));
    assert.ok(bytes.equals(installedBytes), 'Archive member mismatch: ' + name + '/' + path);
    members.push({ path, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  assert.deepEqual(members.map((item) => item.path).sort(), expectedMembers, 'Exact archive inventory');
  archive.members = members;
  const pkg = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.version, version);
  const rootBytes = readFileSync(resolve(root, 'packages', name.split('/')[1], 'dist/index.js'));
  assert.ok(
    rootBytes.equals(readFileSync(resolve(installed, 'dist/index.js'))),
    'Installed bytes differ: ' + name,
  );
}
// Resolve the public API fixture from the independent consumer directory so all
// imports use the copied archive packages, without root workspace aliases.
const declarationFixtureName = '.filtix-public-api-' + process.pid + '.tsx';
const declarationFixture = resolve(cwd, declarationFixtureName);
writeFileSync(declarationFixture, readFileSync(resolve(root, 'tests/package/consumer.tsx')), {
  flag: 'wx',
});
try {
  run([
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--noUncheckedIndexedAccess',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--jsx',
    'react-jsx',
    declarationFixtureName,
  ]);
} finally {
  unlinkSync(declarationFixture);
}
// Check the private subpath from the independent copied packages as well.
for (const extension of ['ts', 'mjs']) {
  const fixtureName = '.filtix-internal-' + process.pid + '.' + extension;
  const fixture = resolve(cwd, fixtureName);
  writeFileSync(fixture, readFileSync(resolve(root, 'tests/package/internal.' + extension)), { flag: 'wx' });
  try {
    if (extension === 'mjs') run([fixtureName]);
    else
      run([
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--noUncheckedIndexedAccess',
        '--skipLibCheck',
        'false',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        fixtureName,
      ]);
  } finally {
    unlinkSync(fixture);
  }
}
run(['node_modules/typescript/bin/tsc', '--noEmit']);
run(['node_modules/vite/bin/vite.js', 'build']);
run([
  '--input-type=module',
  '-e',
  "import {createTerminal} from '@filtix/terminal'; import {FiltixChart} from '@filtix/react'; import {createElement} from 'react'; import {renderToString} from 'react-dom/server'; if(typeof createTerminal!=='function'||!renderToString(createElement(FiltixChart)).includes('div'))throw Error('SSR failure'); console.log('Independent SSR import/render PASS');",
]);
mkdirSync(resolve(root, 'benchmark-results/' + stage), { recursive: true });
const candidateRecord =
  'consumer-install-' + new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '.json';
const evidence = {
  recordedAt: new Date().toISOString(),
  candidateRecord,
  result: 'pass',
  checks: [
    'independent archive install',
    'real copied package paths',
    `all${archives.reduce((sum, archive) => sum + archive.members.length, 0)} archive members identical`,
    'strict TypeScript without aliases',
    'public API NodeNext declarations against installed archives',
    'internal indicator/charts/alerts NodeNext and ESM/SSR ownership and resource fixtures against installed archives',
    'Vite production build',
    'SSR import/render',
  ],
  archives,
  source: sourceIdentity(root),
  builtAssets: identities(root, treeFiles(root, 'examples/react-terminal/dist')),
};
const serialized = JSON.stringify(evidence, null, 2) + '\n';
writeFileSync(resolve(root, 'benchmark-results/' + stage, candidateRecord), serialized);
writeFileSync(resolve(root, 'benchmark-results/' + stage + '/consumer-install.json'), serialized);
console.log('Independent React consumer verification PASS');
