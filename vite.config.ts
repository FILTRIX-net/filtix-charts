import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: 'apps/showcase',
  plugins: [
    {
      name: 'filtix-display-version',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replaceAll('__FILTIX_VERSION__', version),
      },
    },
  ],
  resolve: {
    alias: {
      '@filtix/core': resolve('packages/core/src/index.ts'),
      '@filtix/charts/internal': resolve('packages/charts/src/index.ts'),
      '@filtix/charts': resolve('packages/charts/src/index.ts'),
      '@filtix/indicators/internal': resolve('packages/indicators/src/internal.ts'),
      '@filtix/indicators': resolve('packages/indicators/src/index.ts'),
      '@filtix/react': resolve('packages/react/src/index.tsx'),
      '@filtix/datafeed': resolve('packages/datafeed/src/index.ts'),
      '@filtix/alerts/internal': resolve('packages/alerts/src/index.ts'),
      '@filtix/alerts': resolve('packages/alerts/src/index.ts'),
      '@filtix/drawings': resolve('packages/drawings/src/index.ts'),
      '@filtix/analysis': resolve('packages/analysis/src/index.ts'),
      '@filtix/terminal': resolve('packages/terminal/src/index.ts'),
    },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../../dist/showcase',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve('apps/showcase/index.html'),
        market: resolve('apps/showcase/market.html'),
        terminal: resolve('apps/showcase/terminal.html'),
        drawings: resolve('apps/showcase/drawings.html'),
        analysis: resolve('apps/showcase/analysis.html'),
        analysisBenchmark: resolve('apps/showcase/analysis-benchmark.html'),
        drawingsBenchmark: resolve('apps/showcase/drawings-benchmark.html'),
        benchmark: resolve('apps/showcase/benchmark.html'),
      },
    },
  },
});
