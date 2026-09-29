# @filtix/datafeed

Market data feed sessions and an optional Binance adapter. Part of the FILTIX Charts by FILTIX.net SDK.

## Install

This is a 0.12.0-beta.1 release candidate. Registry installation is available only after the beta is published under the selected npm scope:

```sh
npm install @filtix/datafeed@0.12.0-beta.1
```

For an unpublished local candidate, build and pack the repository, then install the resulting `dist/packages/filtix-datafeed-0.12.0-beta.1.tgz` archive from your consumer project. Install the exact 0.12.0-beta.1 FILTIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtix/datafeed`. Example exports: `createFeedSession, createBinanceProvider`. See the exported declarations for full option and return types.

Required peers: none. Internal FILTIX peers are pinned to `0.12.0-beta.1` for this candidate.

## License

Apache-2.0. See [LICENSE](./LICENSE).
