# @filtrix.net/charts

Canvas chart rendering and interaction. Part of the FILTRIX Charts by FILTRIX.NET SDK.

## Install

Use the `0.12.0-beta.2` cohort consistently across FILTRIX packages:

```sh
npm install @filtrix.net/charts@0.12.0-beta.2
```

To test a local candidate, build and pack the repository, then install the resulting `dist/packages/filtrix.net-charts-0.12.0-beta.2.tgz` archive from your consumer project. Install the exact 0.12.0-beta.2 FILTRIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtrix.net/charts`. Example exports: `createChart, measurePaneLayout, darkTheme, lightTheme`. See the exported declarations for full option and return types.

Required peers: none. Internal FILTRIX peers are pinned to `0.12.0-beta.2` for this beta.

The `@filtrix.net/charts/internal` subpath exists for the SDK cohort; application integrations should use the public entry.

## Attribution and image export

Charts display a small, optional `FILTRIX.NET` link. Disable it at creation with `createChart(host, { attribution: false })` or update it with `chart.applyOptions({ attribution: false })`.

`await chart.exportImage()` returns a PNG with a subtle watermark following the chart's attribution setting. Use `chart.exportImage({ watermark: false })` or `{ watermark: true }` to override that setting for one export. The live canvas and image dimensions are unchanged. The same options pass through the React adapter's existing chart options and ref.

Branding uses no telemetry or remote resources. Hiding it is free and does not change the Apache-2.0 license terms. See the repository's [API guide](https://github.com/FILTRIX-net/filtrix-charts/blob/main/docs/API.md#attribution-and-png-export) for integration details.

## License

Apache-2.0. See [LICENSE](./LICENSE).
