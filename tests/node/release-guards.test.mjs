import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedPackageMembers } from '../../scripts/consumer-identity.mjs';
const guards = await import('../../scripts/release-guards.mjs').catch(() => ({}));

const names = [
  'alerts',
  'analysis',
  'charts',
  'core',
  'datafeed',
  'drawings',
  'indicators',
  'react',
  'terminal',
];
const version = '0.12.0-beta.1';
const repository = { type: 'git', url: 'https://github.com/example/filtrix-charts.git' };
const peerNames = {
  alerts: ['datafeed'],
  analysis: ['charts'],
  drawings: ['charts'],
  react: ['charts'],
  terminal: ['alerts', 'analysis', 'charts', 'datafeed', 'drawings', 'indicators'],
};
function fixture(cohortVersion = version) {
  const workspace = { version: cohortVersion, private: true, license: 'MIT', repository };
  const manifests = Object.fromEntries(
    names.map((name) => [
      name,
      {
        name: '@filtrix.net/' + name,
        version: cohortVersion,
        type: 'module',
        license: 'MIT',
        repository: { ...repository },
        private: false,
        description: 'FILTIX ' + name + ' package',
        homepage: 'https://filtix.net',
        keywords: ['charts', 'filtix'],
        files: ['dist', 'README.md', 'LICENSE'],
        publishConfig: { access: 'public', tag: 'beta' },
        peerDependencies: Object.fromEntries(
          (peerNames[name] ?? []).map((peer) => ['@filtrix.net/' + peer, cohortVersion]),
        ),
      },
    ]),
  );
  manifests.react.peerDependencies.react = '>=18 <20';
  return { workspace, manifests };
}

test('public cohort rejects unresolved legal and repository metadata before publication', () => {
  assert.equal(typeof guards.validatePublicCohort, 'function');
  const { workspace, manifests } = fixture();
  delete workspace.license;
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /license/i);
  workspace.license = 'UNLICENSED';
  for (const manifest of Object.values(manifests)) manifest.license = 'UNLICENSED';
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /license/i);
  workspace.license = 'MIT';
  for (const manifest of Object.values(manifests)) manifest.license = 'MIT';
  delete workspace.repository;
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /repository/i);
});

test('selected license is limited to the offered MIT and Apache-2.0 choices', () => {
  for (const license of ['garbage-placeholder', 'UNLICENSED']) {
    const { workspace, manifests } = fixture();
    workspace.license = license;
    for (const manifest of Object.values(manifests)) manifest.license = license;
    assert.throws(() => guards.validatePublicCohort(workspace, manifests), /license/i);
  }
  const { workspace, manifests } = fixture();
  workspace.license = 'Apache-2.0';
  for (const manifest of Object.values(manifests)) manifest.license = 'Apache-2.0';
  assert.equal(guards.validatePublicCohort(workspace, manifests), 'v0.12-beta.1');
});

test('repository URL needs an HTTPS host and repository path without credentials or fragments', () => {
  for (const url of [
    'https://',
    'https://github.com',
    'https://localhost/team/project.git',
    'https://user:secret@github.com/team/project.git',
    'https://github.com/team/project.git?token=secret',
    'https://github.com/team/project.git#readme',
  ]) {
    const { workspace, manifests } = fixture();
    workspace.repository = { type: 'git', url };
    for (const manifest of Object.values(manifests)) manifest.repository = { ...workspace.repository };
    assert.throws(() => guards.validatePublicCohort(workspace, manifests), /repository/i, url);
  }
});

test('local pack can use a selected license before a repository destination is supplied', () => {
  const { workspace, manifests } = fixture();
  delete workspace.repository;
  for (const manifest of Object.values(manifests)) delete manifest.repository;
  assert.equal(
    guards.validatePublicCohort(workspace, manifests, { requireRepository: false }),
    'v0.12-beta.1',
  );
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /repository/i);
});

test('public cohort rejects private SDK packages, wrong version, legal data, and publish access or tag', () => {
  const cases = [
    [
      (p) => {
        p.alerts.private = true;
      },
      /private/i,
    ],
    [
      (p) => {
        p.alerts.version = '0.11.0';
      },
      /version/i,
    ],
    [
      (p) => {
        p.alerts.license = 'Apache-2.0';
      },
      /license/i,
    ],
    [
      (p) => {
        p.alerts.repository.url = 'https://github.com/example/other.git';
      },
      /repository/i,
    ],
    [
      (p) => {
        p.alerts.publishConfig.access = 'restricted';
      },
      /access/i,
    ],
    [
      (p) => {
        p.alerts.publishConfig.tag = 'latest';
      },
      /tag/i,
    ],
    [
      (p) => {
        p.alerts.peerDependencies['@filtrix.net/datafeed'] = '^0.12.0';
      },
      /peer/i,
    ],
    [
      (p) => {
        delete p.alerts.description;
      },
      /description/i,
    ],
    [
      (p) => {
        p.alerts.files.push('src');
      },
      /files/i,
    ],
  ];
  for (const [mutate, message] of cases) {
    const { workspace, manifests } = fixture();
    mutate(manifests);
    assert.throws(() => guards.validatePublicCohort(workspace, manifests), message);
  }
});

test('public cohort accepts exact internal prerelease peers and external React range', () => {
  const { workspace, manifests } = fixture();
  assert.equal(guards.validatePublicCohort(workspace, manifests), 'v0.12-beta.1');
  delete manifests.terminal;
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /cohort|terminal/i);
});

test('archive guard rejects a missing legal member or an extra source file', () => {
  assert.equal(typeof guards.validatePackedCohort, 'function');
  const { workspace, manifests } = fixture();
  const packed = names.map((name) => ({
    name: '@filtrix.net/' + name,
    version,
    files: [
      { path: 'package.json' },
      { path: 'dist/index.js' },
      { path: 'dist/index.js.map' },
      { path: 'dist/index.d.ts' },
      ...(name === 'alerts' || name === 'charts' || name === 'indicators'
        ? [{ path: 'dist/internal.js' }, { path: 'dist/internal.js.map' }, { path: 'dist/internal.d.ts' }]
        : []),
      { path: 'LICENSE' },
      { path: 'README.md' },
    ],
  }));
  for (const item of packed) item.entryCount = item.files.length;
  assert.doesNotThrow(() => guards.validatePackedCohort(workspace, manifests, packed));
  const missing = structuredClone(packed);
  missing[0].files = missing[0].files.filter(({ path }) => path !== 'LICENSE');
  missing[0].entryCount--;
  assert.throws(() => guards.validatePackedCohort(workspace, manifests, missing), /inventory|member/i);
  const extra = structuredClone(packed);
  extra[0].files.push({ path: 'src/index.ts' });
  extra[0].entryCount++;
  assert.throws(() => guards.validatePackedCohort(workspace, manifests, extra), /inventory|member/i);
});

test('legal files match the selected root license and every package has a README', () => {
  assert.equal(typeof guards.validatePackageLegalFiles, 'function');
  const root = mkdtempSync(join(tmpdir(), 'filtix-legal-'));
  try {
    writeFileSync(join(root, 'LICENSE'), 'selected legal terms\n');
    for (const name of names) {
      const dir = join(root, 'packages', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'LICENSE'), 'selected legal terms\n');
      writeFileSync(join(dir, 'README.md'), '# @filtrix.net/' + name + '\n');
    }
    assert.doesNotThrow(() => guards.validatePackageLegalFiles(root, names));
    writeFileSync(join(root, 'packages', 'alerts', 'LICENSE'), 'different terms\n');
    assert.throws(() => guards.validatePackageLegalFiles(root, names), /license/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('beta release guards reject old-scope manifests and peers', () => {
  const { workspace, manifests } = fixture();
  manifests.alerts.name = '@filtix/alerts';
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /name mismatch/);
  manifests.alerts.name = '@filtrix.net/alerts';
  manifests.alerts.peerDependencies['@filtix/datafeed'] = version;
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /peer/);
});

test('beta.2 public cohort accepts exact package and peer versions', () => {
  const { workspace, manifests } = fixture('0.12.0-beta.2');
  assert.equal(guards.validatePublicCohort(workspace, manifests), 'v0.12-beta.2');
});

test('beta.2 public cohort rejects beta.1 package and peer members', () => {
  const { workspace, manifests } = fixture('0.12.0-beta.2');
  manifests.charts.version = '0.12.0-beta.1';
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /version/i);
  manifests.charts.version = '0.12.0-beta.2';
  manifests.terminal.peerDependencies['@filtrix.net/charts'] = '0.12.0-beta.1';
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /peer/i);
});

test('beta.2 packed cohort accepts its exact members and rejects a beta.1 archive', () => {
  const { workspace, manifests } = fixture('0.12.0-beta.2');
  const packed = names.map((name) => {
    const packageName = '@filtrix.net/' + name;
    const files = expectedPackageMembers('v0.12-beta.2', packageName).map((path) => ({ path }));
    return { name: packageName, version: workspace.version, files, entryCount: files.length };
  });
  assert.doesNotThrow(() => guards.validatePackedCohort(workspace, manifests, packed));
  packed[0].version = '0.12.0-beta.1';
  assert.throws(() => guards.validatePackedCohort(workspace, manifests, packed), /version/i);
});

test('public cohort rejects unlisted prerelease versions', () => {
  const { workspace, manifests } = fixture('0.12.0-beta.3');
  assert.throws(() => guards.validatePublicCohort(workspace, manifests), /version|unsupported|invalid/i);
});
