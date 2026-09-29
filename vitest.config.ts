import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: {
    alias: {
      '@filtix/core': resolve('packages/core/src/index.ts'),
      '@filtix/charts/internal': resolve('packages/charts/src/index.ts'),
      '@filtix/charts': resolve('packages/charts/src/index.ts'),
      '@filtix/datafeed': resolve('packages/datafeed/src/index.ts'),
      '@filtix/alerts/internal': resolve('packages/alerts/src/index.ts'),
      '@filtix/alerts': resolve('packages/alerts/src/index.ts'),
      '@filtix/drawings': resolve('packages/drawings/src/index.ts'),
      '@filtix/analysis': resolve('packages/analysis/src/index.ts'),
      '@filtix/terminal': resolve('packages/terminal/src/index.ts'),
      '@filtix/indicators/internal': resolve('packages/indicators/src/internal.ts'),
      '@filtix/indicators': resolve('packages/indicators/src/index.ts'),
    },
  },
  test: { include: ['packages/**/*.test.ts'], environment: 'node' },
});
