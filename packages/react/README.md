# @filtrix.net/react

React component wrapper for the chart renderer. Part of the FILTRIX Charts by FILTRIX.NET SDK.

## Install

Use the `0.12.0-beta.2` cohort consistently across FILTRIX packages:

```sh
npm install @filtrix.net/react@0.12.0-beta.2
```

To test a local candidate, build and pack the repository, then install the resulting `dist/packages/filtrix.net-react-0.12.0-beta.2.tgz` archive from your consumer project. Install the exact 0.12.0-beta.2 FILTRIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtrix.net/react`. Example exports: `FiltrixChart`. See the exported declarations for full option and return types.

Use `FiltrixChartProps` for component props. The deprecated pre-beta names `FiltixChart` and `FiltixChartProps` remain compatibility aliases.

Required peers: @filtrix.net/charts and React 18 or 19. Internal FILTRIX peers are pinned to `0.12.0-beta.2` for this beta.

## License

Apache-2.0. See [LICENSE](./LICENSE).
