# @filtrix.net/alerts

Price alert state and monitoring. Part of the FILTRIX Charts by FILTRIX.NET SDK.

## Install

Use the `0.12.0-beta.2` cohort consistently across FILTRIX packages:

```sh
npm install @filtrix.net/alerts@0.12.0-beta.2
```

To test a local candidate, build and pack the repository, then install the resulting `dist/packages/filtrix.net-alerts-0.12.0-beta.2.tgz` archive from your consumer project. Install the exact 0.12.0-beta.2 FILTRIX peer packages listed below from the same cohort.

## Entry points

The public ESM and TypeScript entry is `@filtrix.net/alerts`. Example exports: `createPriceAlertStore, createPriceAlertMonitor`. See the exported declarations for full option and return types.

Required peers: @filtrix.net/datafeed. Internal FILTRIX peers are pinned to `0.12.0-beta.2` for this beta.

The `@filtrix.net/alerts/internal` subpath exists for the SDK cohort; application integrations should use the public entry.

## License

Apache-2.0. See [LICENSE](./LICENSE).
