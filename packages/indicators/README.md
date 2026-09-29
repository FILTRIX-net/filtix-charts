# @filtix/indicators

Batch and streaming technical indicator calculations. Part of the FILTIX Charts by FILTIX.net SDK.

## Install

This is a 0.12.0-beta.1 release candidate. Registry installation is available only after the beta is published under the selected npm scope:

```sh
npm install @filtix/indicators@0.12.0-beta.1
```

For an unpublished local candidate, build and pack the repository, then install the resulting `dist/packages/filtix-indicators-0.12.0-beta.1.tgz` archive from your consumer project. Install the exact 0.12.0-beta.1 FILTIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtix/indicators`. Example exports: `ema, sma, rsi, macd, bollingerBands`. See the exported declarations for full option and return types.

Required peers: none. Internal FILTIX peers are pinned to `0.12.0-beta.1` for this candidate.

The `@filtix/indicators/internal` subpath exists for the SDK cohort; application integrations should use the public entry.

## License

Apache-2.0. See [LICENSE](./LICENSE).
