import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scope = [
  'packages',
  'examples/react-terminal',
  'scripts',
  'tests/package',
  'tests/node',
  'package.json',
  'package-lock.json',
  'tsup.config.ts',
  'tsconfig.json',
];
const betaScope = [
  ...scope,
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'docs/OPEN-SOURCE-BETA.md',
  'docs/RELEASE-PROCESS.md',
];
const git = (root, args) =>
  execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
export function treeFiles(root, dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? treeFiles(root, dir + '/' + entry.name) : [dir + '/' + entry.name],
    )
    .sort();
}
export const identities = (root, paths) =>
  paths.map((path) => ({ path, sha256: digest(readFileSync(resolve(root, path))) }));
const stageVersions = new Map([
  ['v0.6', '0.6.0'],
  ['v0.7', '0.7.0'],
  ['v0.8', '0.8.0'],
  ['v0.8.1', '0.8.1'],
  ['v0.9', '0.9.0'],
  ['v0.10', '0.10.0'],
  ['v0.11', '0.11.0'],
  ['v0.12-beta.1', '0.12.0-beta.1'],
]);
const packageNames = [
  'analysis',
  'charts',
  'core',
  'datafeed',
  'drawings',
  'indicators',
  'react',
  'terminal',
];
export function expectedPackageNames(stage) {
  assert.ok(stageVersions.has(stage), 'Unsupported package inventory stage: ' + stage);
  return ['v0.10', 'v0.11', 'v0.12-beta.1'].includes(stage) ? ['alerts', ...packageNames] : [...packageNames];
}
export function expectedPackageMembers(stage, packageName) {
  assert.ok(stageVersions.has(stage), 'Unsupported package inventory stage: ' + stage);
  assert.ok(
    expectedPackageNames(stage).some((name) => packageName === '@filtix/' + name),
    'Unknown cohort package: ' + packageName,
  );
  const members = ['dist/index.d.ts', 'dist/index.js', 'dist/index.js.map', 'package.json'];
  if (
    (['v0.9', 'v0.10', 'v0.11', 'v0.12-beta.1'].includes(stage) && packageName === '@filtix/indicators') ||
    (['v0.10', 'v0.11', 'v0.12-beta.1'].includes(stage) && packageName === '@filtix/alerts') ||
    (['v0.11', 'v0.12-beta.1'].includes(stage) && packageName === '@filtix/charts')
  )
    members.push('dist/internal.d.ts', 'dist/internal.js', 'dist/internal.js.map');
  if (stage === 'v0.12-beta.1') members.push('LICENSE', 'README.md');
  return members.sort();
}
export function releaseStage(version) {
  if (version === '0.12.0-beta.1') return 'v0.12-beta.1';
  assert.match(version, /^0\.\d+\.\d+$/, 'Invalid release version');
  const [major, minor, patch] = version.split('.');
  const stage = 'v' + major + '.' + minor + (patch === '0' ? '' : '.' + patch);
  resolveConsumerCohort(stage, version);
  return stage;
}
export function resolveConsumerCohort(stage, rootVersion) {
  assert.ok(stageVersions.has(stage), 'Unsupported consumer install stage: ' + stage);
  const expectedVersion = stageVersions.get(stage);
  assert.equal(rootVersion, expectedVersion, 'Root package version must agree with install stage');
  return expectedVersion;
}
export function sourceIdentity(root) {
  const rootVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (rootVersion === '0.12.0-beta.1') {
    const normalize = (path) => {
      const absolute = resolve(path).replaceAll('\\', '/');
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    assert.equal(
      normalize(git(root, ['rev-parse', '--show-toplevel'])),
      normalize(root),
      'Beta source root must be the Git repository root',
    );
  }
  const activeScope = rootVersion === '0.12.0-beta.1' ? betaScope : scope;
  return {
    commit: git(root, ['rev-parse', 'HEAD']),
    scope: activeScope,
    dirty: git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...activeScope])
      .split('\n')
      .filter(Boolean),
    files: identities(
      root,
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...activeScope])
        .split('\n')
        .filter(Boolean)
        .sort(),
    ),
  };
}
export function verifyBetaArchiveSourceMember(root, packageName, member, content) {
  assert.ok(member.startsWith('package/'), 'Invalid beta archive member path: ' + member);
  const source = resolve(root, 'packages', packageName, member.slice('package/'.length));
  const sourceBytes = readFileSync(source);
  if (member === 'package/package.json') {
    assert.deepEqual(
      JSON.parse(content.toString('utf8')),
      JSON.parse(sourceBytes.toString('utf8')),
      'Beta archive manifest differs from current source: ' + packageName,
    );
  } else {
    assert.ok(sourceBytes.equals(content), 'Beta archive member differs from current source: ' + member);
  }
}
export function verifyConsumerIdentity(root, stage, commit) {
  const rootVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const expectedVersion = resolveConsumerCohort(stage, rootVersion);
  const pointer = 'benchmark-results/' + stage + '/consumer-install.json',
    bytes = readFileSync(resolve(root, pointer)),
    record = JSON.parse(bytes);
  assert.equal(record.result, 'pass');
  assert.match(record.candidateRecord, /^consumer-install-[0-9TZ-]+\.json$/);
  const unique = 'benchmark-results/' + stage + '/' + record.candidateRecord;
  assert.ok(
    bytes.equals(readFileSync(resolve(root, unique))),
    'Unique install record and pointer must agree',
  );
  assert.equal(record.source.commit, commit, 'Measured commit must match install record');
  assert.deepEqual(record.source.dirty, [], 'Install record must describe committed source');
  assert.deepEqual(
    sourceIdentity(root),
    record.source,
    'Current source must match the installed build record',
  );
  const cohort = expectedPackageNames(stage);
  assert.deepEqual(
    record.archives.map((item) => item.name).sort(),
    cohort.map((name) => '@filtix/' + name),
  );
  const checked = [pointer, unique, ...record.source.files.map((item) => item.path)];
  let memberCount = 0;
  for (const archive of record.archives) {
    const expectedMembers = expectedPackageMembers(stage, archive.name).map((path) => 'package/' + path);
    const name = archive.name.split('/')[1],
      path = 'dist/packages/filtix-' + name + '-' + expectedVersion + '.tgz',
      tarBytes = readFileSync(resolve(root, path));
    assert.equal(digest(tarBytes), archive.sha256, 'Archive differs from install record: ' + name);
    checked.push(path);
    const tar = gunzipSync(tarBytes),
      members = [];
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512),
        member = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
      if (!member) break;
      const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
      const content = tar.subarray(offset + 512, offset + 512 + size);
      offset += 512 + Math.ceil(size / 512) * 512;
      assert.ok(expectedMembers.includes(member), 'Unexpected archive member: ' + member);
      const installed = 'examples/react-terminal/node_modules/@filtix/' + name + '/' + member.slice(8),
        actual = readFileSync(resolve(root, installed));
      assert.ok(actual.equals(content), 'Installed member differs from archive: ' + installed);
      if (stage === 'v0.12-beta.1') verifyBetaArchiveSourceMember(root, name, member, content);
      members.push({ path: member, bytes: size, sha256: digest(content) });
      checked.push(installed);
    }
    assert.equal(
      JSON.parse(
        readFileSync(
          resolve(root, 'examples/react-terminal/node_modules/@filtix/' + name + '/package.json'),
          'utf8',
        ),
      ).version,
      expectedVersion,
    );
    assert.deepEqual(members.map((item) => item.path).sort(), expectedMembers, 'Exact archive inventory');
    assert.deepEqual(members, archive.members, 'All member records must match actual archives');
    memberCount += members.length;
  }
  const assets = treeFiles(root, 'examples/react-terminal/dist');
  assert.deepEqual(
    assets,
    record.builtAssets.map((item) => item.path),
    'Built asset inventory changed',
  );
  for (const item of record.builtAssets) {
    assert.equal(
      digest(readFileSync(resolve(root, item.path))),
      item.sha256,
      'Built consumer asset changed: ' + item.path,
    );
    checked.push(item.path);
  }
  return {
    record: unique,
    sourceCommit: commit,
    version: expectedVersion,
    archives: cohort.length,
    members: memberCount,
    identities: identities(root, [...new Set(checked)].sort()),
  };
}
