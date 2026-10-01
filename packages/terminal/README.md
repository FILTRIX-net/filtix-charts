# @filtrix.net/terminal

Composed terminal and multi-chart grid. Part of the FILTRIX Charts by FILTRIX.NET SDK.

## Install

Use the `0.12.0-beta.2` cohort consistently across FILTRIX packages:

```sh
npm install @filtrix.net/terminal@0.12.0-beta.2
```

To test a local candidate, build and pack the repository, then install the resulting `dist/packages/filtrix.net-terminal-0.12.0-beta.2.tgz` archive from your consumer project. Install the exact 0.12.0-beta.2 FILTRIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtrix.net/terminal`. Example exports: `createTerminal, createTerminalGrid`. See the exported declarations for full option and return types.

Required peers: @filtrix.net/alerts, @filtrix.net/analysis, @filtrix.net/charts, @filtrix.net/datafeed, @filtrix.net/drawings and @filtrix.net/indicators. Internal FILTRIX peers are pinned to `0.12.0-beta.2` for this beta.

## License

Apache-2.0. See [LICENSE](./LICENSE).
