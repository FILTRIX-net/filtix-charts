import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expectedPackageMembers,
  expectedPackageNames,
  isPublicBetaStage,
  releaseStage,
} from './consumer-identity.mjs';

const internalPeers = {
  alerts: ['datafeed'],
  analysis: ['charts'],
  drawings: ['charts'],
  react: ['charts'],
  terminal: ['alerts', 'analysis', 'charts', 'datafeed', 'drawings', 'indicators'],
};

export function validatePublicCohort(workspace, manifests, { requireRepository = true } = {}) {
  assert.equal(workspace.private, true, 'Root workspace must remain private');
  const stage = releaseStage(workspace.version);
  assert.ok(isPublicBetaStage(stage), 'Root version must be a supported public beta version');
  const betaVersion = workspace.version;
  assert.ok(
    ['MIT', 'Apache-2.0'].includes(workspace.license),
    'Selected license is required before publication',
  );
  if (requireRepository || workspace.repository !== undefined) {
    assert.ok(
      typeof workspace.repository?.url === 'string' && workspace.repository.url.trim(),
      'Real repository metadata is required before publication',
    );
    let repository;
    try {
      repository = new URL(workspace.repository.url.replace(/^git\+/, ''));
    } catch {
      assert.fail('Repository URL must be a public HTTPS Git destination');
    }
    assert.ok(
      repository.protocol === 'https:' &&
        repository.hostname.includes('.') &&
        repository.pathname.split('/').filter(Boolean).length >= 2 &&
        !repository.username &&
        !repository.password &&
        !repository.search &&
        !repository.hash,
      'Repository URL must be a public HTTPS Git destination without credentials or fragments',
    );
  }
  const names = expectedPackageNames(stage);
  assert.deepEqual(Object.keys(manifests).sort(), [...names].sort(), 'Exact public package cohort');
  for (const name of names) {
    const manifest = manifests[name];
    assert.equal(manifest.name, '@filtrix.net/' + name, name + ' package name mismatch');
    assert.equal(manifest.version, betaVersion, name + ' package version mismatch');
    assert.equal(manifest.private, false, name + ' private SDK package cannot be published');
    assert.equal(manifest.license, workspace.license, name + ' license must match selected root license');
    assert.deepEqual(
      manifest.repository,
      workspace.repository,
      name + ' repository must match the root destination',
    );
    assert.ok(
      typeof manifest.description === 'string' && manifest.description.trim(),
      name + ' description is required',
    );
    assert.ok(
      typeof manifest.homepage === 'string' && /^https:\/\//.test(manifest.homepage),
      name + ' HTTPS homepage is required',
    );
    assert.ok(
      Array.isArray(manifest.keywords) &&
        manifest.keywords.length > 0 &&
        manifest.keywords.every((word) => typeof word === 'string' && word.trim()),
      name + ' keywords are required',
    );
    assert.deepEqual(
      [...(manifest.files ?? [])].sort(),
      ['dist', 'README.md', 'LICENSE'].sort(),
      name + ' files must contain only build and legal entries',
    );
    assert.equal(manifest.publishConfig?.access, 'public', name + ' publish access must be public');
    assert.equal(manifest.publishConfig?.tag, 'beta', name + ' publish tag must be beta');
    const actualPeers = Object.entries(manifest.peerDependencies ?? {})
      .filter(([peer]) => peer.startsWith('@filtrix.net/') || peer.startsWith('@filtix/'))
      .sort();
    const expectedPeers = (internalPeers[name] ?? [])
      .map((peer) => ['@filtrix.net/' + peer, betaVersion])
      .sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(actualPeers, expectedPeers, name + ' internal peer versions must be exact beta pins');
  }
  return stage;
}

export function validatePackageLegalFiles(root, names) {
  const license = readFileSync(resolve(root, 'LICENSE'));
  assert.ok(license.length > 0, 'Selected root LICENSE must not be empty');
  for (const name of names) {
    const directory = resolve(root, 'packages', name);
    assert.deepEqual(
      readFileSync(resolve(directory, 'LICENSE')),
      license,
      name + ' package LICENSE must match selected root license',
    );
    const readme = readFileSync(resolve(directory, 'README.md'), 'utf8');
    assert.ok(readme.trim(), name + ' package README.md must not be empty');
  }
}

export function validatePackedCohort(workspace, manifests, packed, options) {
  const stage = validatePublicCohort(workspace, manifests, options);
  const betaVersion = workspace.version;
  const names = expectedPackageNames(stage);
  assert.deepEqual(
    packed.map(({ name }) => name).sort(),
    names.map((name) => '@filtrix.net/' + name).sort(),
    'Exact public archive cohort',
  );
  for (const item of packed) {
    assert.equal(item.version, betaVersion, item.name + ' archive version mismatch');
    const expected = expectedPackageMembers(stage, item.name);
    assert.equal(item.entryCount, expected.length, item.name + ' archive member count mismatch');
    assert.deepEqual(
      item.files.map(({ path }) => path).sort(),
      expected,
      item.name + ' exact archive inventory mismatch',
    );
  }
}
