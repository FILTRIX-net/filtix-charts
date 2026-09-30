import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const publicDemo = mode === 'public-demo';
  return {
    root: 'apps/showcase',
    base: publicDemo ? './' : '/',
    plugins: [
      {
        name: 'filtix-display-version',
        transformIndexHtml: {
          order: 'pre',
          handler: (html) => {
            const versioned = html.replaceAll('__FILTIX_VERSION__', version);
            if (!publicDemo) return versioned;
            return versioned
              .replace(/<a\b[^>]*\bdata-development-only\b[^>]*>[\s\S]*?<\/a>/g, '')
              .replace(/(<a\b[^>]*\bhref=["'])\/(?!\/)/g, '$1./');
          },
        },
      },
    ],
    resolve: {
      alias: {
        '@filtrix.net/core': resolve('packages/core/src/index.ts'),
        '@filtrix.net/charts/internal': resolve('packages/charts/src/index.ts'),
        '@filtrix.net/charts': resolve('packages/charts/src/index.ts'),
        '@filtrix.net/indicators/internal': resolve('packages/indicators/src/internal.ts'),
        '@filtrix.net/indicators': resolve('packages/indicators/src/index.ts'),
        '@filtrix.net/react': resolve('packages/react/src/index.tsx'),
        '@filtrix.net/datafeed': resolve('packages/datafeed/src/index.ts'),
        '@filtrix.net/alerts/internal': resolve('packages/alerts/src/index.ts'),
        '@filtrix.net/alerts': resolve('packages/alerts/src/index.ts'),
        '@filtrix.net/drawings': resolve('packages/drawings/src/index.ts'),
        '@filtrix.net/analysis': resolve('packages/analysis/src/index.ts'),
        '@filtrix.net/terminal': resolve('packages/terminal/src/index.ts'),
      },
    },
    server: { port: 5173, strictPort: true },
    build: {
      outDir: publicDemo ? '../../dist/public-demo' : '../../dist/showcase',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve('apps/showcase/index.html'),
          market: resolve('apps/showcase/market.html'),
          terminal: resolve('apps/showcase/terminal.html'),
          drawings: resolve('apps/showcase/drawings.html'),
          analysis: resolve('apps/showcase/analysis.html'),
          ...(!publicDemo && {
            analysisBenchmark: resolve('apps/showcase/analysis-benchmark.html'),
            drawingsBenchmark: resolve('apps/showcase/drawings-benchmark.html'),
            benchmark: resolve('apps/showcase/benchmark.html'),
          }),
        },
      },
    },
  };
});
