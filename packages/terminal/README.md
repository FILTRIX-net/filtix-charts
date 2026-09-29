# @filtix/terminal

Composed terminal and multi-chart grid. Part of the FILTIX Charts by FILTIX.net SDK.

## Install

This is a 0.12.0-beta.1 release candidate. Registry installation is available only after the beta is published under the selected npm scope:

```sh
npm install @filtix/terminal@0.12.0-beta.1
```

For an unpublished local candidate, build and pack the repository, then install the resulting `dist/packages/filtix-terminal-0.12.0-beta.1.tgz` archive from your consumer project. Install the exact 0.12.0-beta.1 FILTIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtix/terminal`. Example exports: `createTerminal, createTerminalGrid`. See the exported declarations for full option and return types.

Required peers: @filtix/alerts, @filtix/analysis, @filtix/charts, @filtix/datafeed, @filtix/drawings and @filtix/indicators. Internal FILTIX peers are pinned to `0.12.0-beta.1` for this candidate.

## License

Apache-2.0. See [LICENSE](./LICENSE).
