import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as identity from '../../scripts/consumer-identity.mjs';
import {
  expectedPackageMembers,
  expectedPackageNames,
  resolveConsumerCohort,
  releaseStage,
} from '../../scripts/consumer-identity.mjs';

const names = ['analysis', 'charts', 'core', 'datafeed', 'drawings', 'indicators', 'react', 'terminal'];
const ordinary = ['dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
test('v0.9 requires the real indicator internal entry and exactly 35 members', () => {
  const inventory = names.map((name) => expectedPackageMembers('v0.9', '@filtix/' + name));
  assert.equal(inventory.flat().length, 35);
  for (let i = 0; i < names.length; i++)
    assert.deepEqual(
      inventory[i],
      names[i] === 'indicators'
        ? [...ordinary, 'dist/internal.d.ts', 'dist/internal.js', 'dist/internal.js.map'].sort()
        : ordinary,
    );
});
test('historical cohorts retain the original exact 32-member inventory', () => {
  for (const stage of ['v0.6', 'v0.7', 'v0.8', 'v0.8.1']) {
    for (const name of names) assert.deepEqual(expectedPackageMembers(stage, '@filtix/' + name), ordinary);
  }
});
test('unknown cohorts and packages cannot silently use a permissive inventory', () => {
  assert.throws(() => expectedPackageMembers('v0.12', '@filtix/indicators'));
  assert.throws(() => expectedPackageMembers('v0.9', '@filtix/alerts'));
  const first = expectedPackageMembers('v0.9', '@filtix/indicators');
  first.pop();
  assert.equal(expectedPackageMembers('v0.9', '@filtix/indicators').length, 7);
});

test('v0.10 requires nine packages and exactly 42 members with both internal entries', () => {
  const currentNames = ['alerts', ...names];
  const inventory = currentNames.map((name) => expectedPackageMembers('v0.10', '@filtix/' + name));
  assert.equal(inventory.flat().length, 42);
  for (let i = 0; i < currentNames.length; i++)
    assert.deepEqual(
      inventory[i],
      ['alerts', 'indicators'].includes(currentNames[i])
        ? [...ordinary, 'dist/internal.d.ts', 'dist/internal.js', 'dist/internal.js.map'].sort()
        : ordinary,
    );
  assert.throws(() => expectedPackageMembers('v0.10', '@filtix/unknown'));
  const copy = expectedPackageMembers('v0.10', '@filtix/alerts');
  copy.length = 0;
  assert.equal(expectedPackageMembers('v0.10', '@filtix/alerts').length, 7);
});

test('cohort names and versions agree without mutating historical inventories', () => {
  assert.deepEqual(expectedPackageNames('v0.9'), names);
  assert.deepEqual(expectedPackageNames('v0.10'), ['alerts', ...names]);
  const copy = expectedPackageNames('v0.10');
  copy.pop();
  assert.equal(expectedPackageNames('v0.10').length, 9);
  assert.equal(releaseStage('0.10.0'), 'v0.10');
  assert.equal(resolveConsumerCohort('v0.10', '0.10.0'), '0.10.0');
  assert.throws(() => resolveConsumerCohort('v0.10', '0.9.0'));
  assert.throws(() => resolveConsumerCohort('v0.9', '0.10.0'));
  assert.throws(() => expectedPackageNames('v0.12'));
});

test('v0.11 grid cohort requires nine archives and exact 45-member internal ownership entries', () => {
  assert.equal(releaseStage('0.11.0'), 'v0.11');
  assert.equal(resolveConsumerCohort('v0.11', '0.11.0'), '0.11.0');
  assert.throws(() => resolveConsumerCohort('v0.11', '0.10.0'));
  assert.throws(() => resolveConsumerCohort('v0.10', '0.11.0'));
  assert.deepEqual(expectedPackageNames('v0.11'), ['alerts', ...names]);
  const inventory = expectedPackageNames('v0.11').map((name) =>
    expectedPackageMembers('v0.11', '@filtix/' + name),
  );
  assert.equal(inventory.flat().length, 45);
  for (const name of ['alerts', ...names])
    assert.deepEqual(
      expectedPackageMembers('v0.11', '@filtix/' + name),
      name === 'charts'
        ? [...ordinary, 'dist/internal.d.ts', 'dist/internal.js', 'dist/internal.js.map'].sort()
        : expectedPackageMembers('v0.10', '@filtix/' + name),
    );
  assert.throws(() => expectedPackageMembers('v0.11', '@filtix/unknown'));
});

test('beta stage keeps the nine-package cohort and adds two legal members per archive', () => {
  assert.equal(releaseStage('0.12.0-beta.1'), 'v0.12-beta.1');
  assert.equal(resolveConsumerCohort('v0.12-beta.1', '0.12.0-beta.1'), '0.12.0-beta.1');
  assert.deepEqual(expectedPackageNames('v0.12-beta.1'), ['alerts', ...names]);
  const inventory = expectedPackageNames('v0.12-beta.1').map((name) =>
    expectedPackageMembers('v0.12-beta.1', '@filtrix.net/' + name),
  );
  assert.equal(inventory.flat().length, 63);
  for (const name of ['alerts', ...names])
    assert.deepEqual(
      expectedPackageMembers('v0.12-beta.1', '@filtrix.net/' + name),
      [...expectedPackageMembers('v0.11', '@filtix/' + name), 'LICENSE', 'README.md'].sort(),
    );
  assert.equal(
    expectedPackageNames('v0.11').flatMap((name) => expectedPackageMembers('v0.11', '@filtix/' + name))
      .length,
    45,
  );
});

test('unlisted prereleases and mismatched beta stages cannot resolve to an older cohort', () => {
  assert.throws(() => releaseStage('0.12.0-beta.2'), /Unsupported|Invalid/);
  assert.throws(() => releaseStage('0.12.0'), /Unsupported/);
  assert.throws(() => resolveConsumerCohort('v0.12-beta.1', '0.11.0'), /agree/);
  assert.throws(() => resolveConsumerCohort('v0.11', '0.12.0-beta.1'), /agree/);
  assert.throws(() => expectedPackageNames('v0.12-beta.2'), /Unsupported/);
});

test('beta archive bytes must match current source even when archive and install agree', () => {
  const root = mkdtempSync(join(tmpdir(), 'filtix-beta-identity-'));
  try {
    const pkg = join(root, 'packages', 'alerts');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    const manifest = {
      name: '@filtrix.net/alerts',
      version: '0.12.0-beta.1',
      private: false,
      license: 'MIT',
    };
    writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(pkg, 'LICENSE'), 'selected MIT terms\n');
    writeFileSync(join(pkg, 'README.md'), '# Current README\n');
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export const current = true;\n');
    const members = [
      [
        'package/package.json',
        Buffer.from(JSON.stringify({ ...manifest, private: true, license: 'UNLICENSED' })),
      ],
      ['package/LICENSE', Buffer.from('outdated legal terms\n')],
      ['package/README.md', Buffer.from('# Old README\n')],
      ['package/dist/index.js', Buffer.from('export const current = false;\n')],
    ];
    for (const [member, archiveBytes] of members) {
      const installedBytes = Buffer.from(archiveBytes);
      assert.ok(archiveBytes.equals(installedBytes));
      assert.throws(
        () => identity.verifyBetaArchiveSourceMember(root, 'alerts', member, archiveBytes),
        /source|manifest/i,
        member,
      );
    }
    for (const member of [
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.js',
    ]) {
      const sourceBytes = Buffer.from(
        member === 'package/package.json'
          ? JSON.stringify(manifest)
          : member === 'package/LICENSE'
            ? 'selected MIT terms\n'
            : member === 'package/README.md'
              ? '# Current README\n'
              : 'export const current = true;\n',
      );
      assert.doesNotThrow(() => identity.verifyBetaArchiveSourceMember(root, 'alerts', member, sourceBytes));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('beta source identity rejects an ignored nested export inheriting its parent Git repository', () => {
  const parent = mkdtempSync(join(tmpdir(), 'filtix-beta-git-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', ...args], {
      cwd: parent,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  try {
    git('init');
    writeFileSync(join(parent, 'package.json'), JSON.stringify({ version: '0.12.0-beta.1' }));
    writeFileSync(join(parent, '.gitignore'), 'nested/\n');
    git('add', 'package.json', '.gitignore');
    git('-c', 'user.name=FILTIX Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
    const proper = identity.sourceIdentity(parent);
    assert.equal(proper.commit, git('rev-parse', 'HEAD'));
    assert.ok(proper.files.some((item) => item.path === 'package.json'));
    const nested = join(parent, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ version: '0.12.0-beta.1' }));
    assert.throws(() => identity.sourceIdentity(nested), /Git repository root|source root/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('package scope, archive names and installed paths follow the release stage', () => {
  for (const [stage, version, scope, prefix] of [
    ['v0.11', '0.11.0', '@filtix', 'filtix'],
    ['v0.12-beta.1', '0.12.0-beta.1', '@filtrix.net', 'filtrix.net'],
  ]) {
    assert.equal(identity.expectedPackageScope(stage), scope);
    assert.equal(
      identity.packageArchivePath(stage, 'charts'),
      `dist/packages/${prefix}-charts-${version}.tgz`,
    );
    assert.equal(
      identity.consumerPackagePath(stage, 'charts', 'dist/index.js'),
      `examples/react-terminal/node_modules/${scope}/charts/dist/index.js`,
    );
    assert.throws(
      () => expectedPackageMembers(stage, `${scope === '@filtix' ? '@filtrix.net' : '@filtix'}/charts`),
      /Unknown cohort/,
    );
  }
  assert.throws(() => identity.packageArchivePath('v0.12-beta.1', '../charts'), /Unknown cohort/);
});
