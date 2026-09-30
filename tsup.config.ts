import { execFileSync } from 'node:child_process';
import { build, defineConfig } from 'tsup';

const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@filtrix.net/alerts',
  '@filtrix.net/alerts/internal',
  '@filtrix.net/analysis',
  '@filtrix.net/charts',
  '@filtrix.net/charts/internal',
  '@filtrix.net/datafeed',
  '@filtrix.net/drawings',
  '@filtrix.net/indicators',
  '@filtrix.net/indicators/internal',
];
export default defineConfig(
  ['core', 'charts', 'indicators', 'react', 'datafeed', 'drawings', 'analysis', 'alerts', 'terminal'].map(
    (name) => ({
      entry: {
        index: `packages/${name}/src/index.${name === 'react' ? 'tsx' : 'ts'}`,
        ...(name === 'indicators' ? { internal: 'packages/indicators/src/internal.ts' } : {}),
      },
      outDir: `packages/${name}/dist`,
      format: ['esm'],
      target: 'es2022',
      dts: !['indicators', 'alerts', 'charts'].includes(name),
      sourcemap: true,
      clean: true,
      minify: true,
      splitting: false,
      noExternal: ['@filtrix.net/core'],
      external,
      // Separate declaration bundles preserve the root surface and avoid shared DTS chunks.
      // Run after this package's JS cleanup, then sequentially without another cleanup.
      onSuccess:
        name === 'alerts' || name === 'charts'
          ? async () => {
              await build({
                config: false,
                entry: { index: `packages/${name}/src/index.ts` },
                outDir: `packages/${name}/dist`,
                format: ['esm'],
                target: 'es2022',
                dts: { only: true },
                clean: false,
                splitting: false,
                noExternal: ['@filtrix.net/core'],
                external,
              });
              execFileSync(process.execPath, [`scripts/build-${name}-internal.mjs`], {
                stdio: 'inherit',
                windowsHide: true,
              });
            }
          : name === 'indicators'
            ? async () => {
                for (const entry of ['index', 'internal']) {
                  await build({
                    config: false,
                    entry: { [entry]: `packages/indicators/src/${entry}.ts` },
                    outDir: 'packages/indicators/dist',
                    format: ['esm'],
                    target: 'es2022',
                    dts: { only: true },
                    clean: false,
                    splitting: false,
                    noExternal: ['@filtrix.net/core'],
                    external,
                  });
                }
              }
            : undefined,
    }),
  ),
);
