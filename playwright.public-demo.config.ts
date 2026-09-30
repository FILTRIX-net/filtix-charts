import { defineConfig } from '@playwright/test';

const firstPort = Number(process.env.FILTRIX_DEMO_TEST_PORT ?? 5183);
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65534) {
  throw new Error('FILTRIX_DEMO_TEST_PORT must be an integer from 1024 to 65534');
}
const rootOrigin = `http://127.0.0.1:${firstPort}`;
const projectOrigin = `http://127.0.0.1:${firstPort + 1}`;
const chromium = {
  browserName: 'chromium' as const,
  ...(!process.env.CI && process.platform === 'win32' ? { channel: 'chrome' } : {}),
};

export default defineConfig({
  testDir: 'tests/public-demo',
  outputDir: 'test-results/public-demo',
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'root-desktop',
      use: { ...chromium, baseURL: rootOrigin + '/', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'project-desktop',
      use: {
        ...chromium,
        baseURL: projectOrigin + '/filtix-charts/',
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'project-mobile',
      use: {
        ...chromium,
        baseURL: projectOrigin + '/filtix-charts/',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: `node node_modules/vite/bin/vite.js preview --mode public-demo --host 127.0.0.1 --port ${firstPort} --strictPort --base /`,
      url: rootOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js preview --mode public-demo --host 127.0.0.1 --port ${firstPort + 1} --strictPort --base /filtix-charts/`,
      url: projectOrigin + '/filtix-charts/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
