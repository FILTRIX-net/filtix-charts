import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// npm run supplies its actual CLI path on every supported platform. Direct
// node invocations fall back to the verified Node distribution layouts.
export function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error('Cannot locate npm CLI. Run this check through its npm run command.');
}
