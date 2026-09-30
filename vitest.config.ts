import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: {
    alias: {
      '@filtrix.net/core': resolve('packages/core/src/index.ts'),
      '@filtrix.net/charts/internal': resolve('packages/charts/src/index.ts'),
      '@filtrix.net/charts': resolve('packages/charts/src/index.ts'),
      '@filtrix.net/datafeed': resolve('packages/datafeed/src/index.ts'),
      '@filtrix.net/alerts/internal': resolve('packages/alerts/src/index.ts'),
      '@filtrix.net/alerts': resolve('packages/alerts/src/index.ts'),
      '@filtrix.net/drawings': resolve('packages/drawings/src/index.ts'),
      '@filtrix.net/analysis': resolve('packages/analysis/src/index.ts'),
      '@filtrix.net/terminal': resolve('packages/terminal/src/index.ts'),
      '@filtrix.net/indicators/internal': resolve('packages/indicators/src/internal.ts'),
      '@filtrix.net/indicators': resolve('packages/indicators/src/index.ts'),
    },
  },
  test: { include: ['packages/**/*.test.ts'], environment: 'node' },
});
