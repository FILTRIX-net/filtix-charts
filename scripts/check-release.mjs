import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedPackageNames,
  isPublicBetaStage,
  releaseStage,
  verifyConsumerIdentity,
} from './consumer-identity.mjs';
import { validatePackageLegalFiles, validatePackedCohort, validatePublicCohort } from './release-guards.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const stage = releaseStage(workspace.version);
assert.ok(isPublicBetaStage(stage), 'Public release preflight is limited to explicit beta stages');
const names = expectedPackageNames(stage);
const manifests = Object.fromEntries(
  names.map((name) => [
    name,
    JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')),
  ]),
);
validatePublicCohort(workspace, manifests);
validatePackageLegalFiles(root, names);
const packed = JSON.parse(readFileSync(resolve(root, 'docs/releases', stage + '-packages.json'), 'utf8'));
validatePackedCohort(workspace, manifests, packed);
const commit = execFileSync('git', ['-c', 'core.longpaths=true', 'rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const installed = verifyConsumerIdentity(root, stage, commit);
console.log(
  JSON.stringify({ stage, commit, packages: names.length, members: installed.members, result: 'pass' }),
);
