# @filtix/charts

Canvas chart rendering and interaction. Part of the FILTIX Charts by FILTIX.net SDK.

## Install

This is a 0.12.0-beta.1 release candidate. Registry installation is available only after the beta is published under the selected npm scope:

```sh
npm install @filtix/charts@0.12.0-beta.1
```

For an unpublished local candidate, build and pack the repository, then install the resulting `dist/packages/filtix-charts-0.12.0-beta.1.tgz` archive from your consumer project. Install the exact 0.12.0-beta.1 FILTIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtix/charts`. Example exports: `createChart, measurePaneLayout, darkTheme, lightTheme`. See the exported declarations for full option and return types.

Required peers: none. Internal FILTIX peers are pinned to `0.12.0-beta.1` for this candidate.

The `@filtix/charts/internal` subpath exists for the SDK cohort; application integrations should use the public entry.

## License

Apache-2.0. See [LICENSE](./LICENSE).
