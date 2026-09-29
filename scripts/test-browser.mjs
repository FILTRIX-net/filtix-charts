import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result = spawnSync(
  process.execPath,
  ['node_modules/playwright/cli.js', 'test', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve('.playwright') },
  },
);
process.exit(result.status ?? 1);
