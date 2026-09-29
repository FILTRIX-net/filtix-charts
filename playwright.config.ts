import { defineConfig, devices } from '@playwright/test';
const testPort = Number(process.env.FILTIX_TEST_PORT ?? 5176);
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)
  throw new Error('FILTIX_TEST_PORT must be an integer from 1024 to 65535');
const testOrigin = 'http://127.0.0.1:' + testPort;
export default defineConfig({
  outputDir: 'test-results/port-' + testPort,
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/port-' + testPort }]],
  use: {
    baseURL: testOrigin,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(!process.env.CI && process.platform === 'win32' ? { channel: 'chrome' } : {}),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ' + testPort,
    url: testOrigin + '/test.html',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
