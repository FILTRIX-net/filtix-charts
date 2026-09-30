# @filtrix.net/analysis

Chart synchronization, indexed comparison and history replay. Part of the FILTRIX Charts by FILTRIX.NET SDK.

## Install

This is a 0.12.0-beta.1 release candidate. Registry installation is available only after the beta is published under the selected npm scope:

```sh
npm install @filtrix.net/analysis@0.12.0-beta.1
```

For an unpublished local candidate, build and pack the repository, then install the resulting `dist/packages/filtrix.net-analysis-0.12.0-beta.1.tgz` archive from your consumer project. Install the exact 0.12.0-beta.1 FILTRIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtrix.net/analysis`. Example exports: `createChartSync, buildIndexedComparison, createHistoryReplay`. See the exported declarations for full option and return types.

Required peers: @filtrix.net/charts. Internal FILTRIX peers are pinned to `0.12.0-beta.1` for this candidate.

## License

Apache-2.0. See [LICENSE](./LICENSE).
