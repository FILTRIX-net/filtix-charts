import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findNpmCli } from './npm-cli.mjs';
import {
  releaseStage,
  expectedPackageMembers,
  expectedPackageNames,
  expectedPackageScope,
  isPublicBetaStage,
} from './consumer-identity.mjs';
import { validatePublicCohort, validatePackageLegalFiles, validatePackedCohort } from './release-guards.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(workspace.private, true, 'Release packaging expects a private workspace');
const stage = releaseStage(workspace.version);
const cohort = expectedPackageNames(stage);
const manifests = Object.fromEntries(
  cohort.map((name) => [
    name,
    JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')),
  ]),
);
if (isPublicBetaStage(stage)) {
  validatePublicCohort(workspace, manifests, { requireRepository: false });
  validatePackageLegalFiles(root, cohort);
}
mkdirSync(resolve(root, 'dist/packages'), { recursive: true });
const npmCli = findNpmCli();
const result = spawnSync(
  process.execPath,
  [npmCli, 'pack', '--workspaces', '--json', '--ignore-scripts', '--pack-destination', 'dist/packages'],
  {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  },
);
assert.equal(result.status, 0, result.stdout + result.stderr);
const packed = JSON.parse(result.stdout);
// Older npm versions return an array; npm 12 keys workspace results by package name.
assert.ok(packed && typeof packed === 'object', 'Invalid npm pack JSON result');
const packages = Array.isArray(packed)
  ? packed
  : Object.entries(packed).map(([name, item]) => {
      assert.equal(item?.name, name, 'npm pack result key/name mismatch');
      return item;
    });
assert.equal(packages.length, cohort.length);
assert.deepEqual(
  packages.map((item) => item.name).sort(),
  cohort.map((name) => expectedPackageScope(stage) + '/' + name),
  'Release must contain the exact stage package cohort',
);
for (const item of packages) {
  assert.equal(item.version, workspace.version);
  const expectedMembers = expectedPackageMembers(stage, item.name);
  assert.equal(item.entryCount, expectedMembers.length);
  assert.deepEqual(item.files.map((file) => file.path).sort(), expectedMembers);
  if (!isPublicBetaStage(stage)) assert.equal(manifests[item.name.split('/')[1]].private, true);
}
if (isPublicBetaStage(stage))
  validatePackedCohort(workspace, manifests, packages, { requireRepository: false });
const output = resolve(root, 'docs/releases', stage + '-packages.json');
writeFileSync(output, JSON.stringify(packages, null, 2) + '\n');
console.log(
  JSON.stringify({
    stage,
    packages: packages.map(({ name, size, filename }) => ({ name, size, filename })),
    evidence: output,
  }),
);
