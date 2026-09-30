# FILTRIX Charts beta

FILTRIX Charts by FILTRIX.NET is a standalone financial charting library. The beta preparation targets developers building web applications and traders evaluating the demo. Using the SDK does not require a FILTRIX account. The SDK has no analytics or telemetry service.

## Availability

`0.12.0-beta.1` is published on npm with the `beta` tag under [Apache-2.0](../LICENSE). Source is available at [FILTRIX-net/filtix-charts](https://github.com/FILTRIX-net/filtix-charts). All nine SDK packages use the `@filtrix.net` scope. All nine packages are available from npm; the [public demo](https://charts.filtrix.net/) is live.

Use the [workspace setup](../README.md#run-the-workspace) to run the source checkout. `npm run build`, `npm run pack:local` and `npm run check:consumer` build and verify local archives. Install the chart engine with `npm install @filtrix.net/charts@0.12.0-beta.1`. The [release process](RELEASE-PROCESS.md) describes publication and qualification.

## Try a workflow

| Demo                       | What to try                                                             | Data                                           |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| Studio, `/`                | Switch chart types, edit colors, start the simulated stream, export PNG | Deterministic synthetic fixtures               |
| Market, `/market.html`     | Browse history, change interval, watch reconnect state                  | Public Binance Spot REST and WebSocket         |
| Drawings, `/drawings.html` | Annotate a chart and save a layout in this browser                      | Demo fixtures                                  |
| Analysis, `/analysis.html` | Compare indexed series and reveal historical data through replay        | Labelled synthetic fixtures with missing hours |
| Terminal, `/terminal.html` | Combine studies, drawings and saved price alerts                        | Public Binance Spot provider                   |
| Independent React example  | Mount, dispose and restore single/grid terminal views                   | Synthetic mode or optional Binance provider    |

The chart library does not supply an exchange data entitlement or execute orders. Your application chooses its data source. Demo prices are labelled; network availability and upstream provider limits can affect live pages. Saved demo layouts and alerts live in the browser, not a FILTRIX account.

## Beta expectations

The API is pre-1.0. Pin exact beta versions and keep all `@filtrix.net/*` peers in the same cohort. Read the changelog before updating. Numeric chart timestamps use UTC milliseconds, containers need an explicit size, and mounted charts/terminals must be destroyed on unmount. Start with the [API guide](API.md), [React example](../examples/react-terminal/README.md) or [terminal contract](TERMINAL-CONTRACT.md).

Historical benchmarks describe their named hardware, workload, package versions and commits. They are not measurements of this beta candidate or a comparison against TradingView. Real-device touch testing and your application's provider/load profile remain separate verification work. See the [performance methodology](PERFORMANCE.md).

## Support experiment

The proposed initial maintenance budget is two hours per week for four weeks, subject to the owner's operating schedule. Triage reproducible installation failures, data correctness and lifecycle regressions first. This is a planning budget, not a guaranteed response time or support contract. Broad feature requests are collected for later prioritization.

Use the repository's [issues](https://github.com/FILTRIX-net/filtix-charts/issues) for reproducible bugs and proposals. See [contribution guidance](../CONTRIBUTING.md).

## Acquisition measurement

The commercial hypothesis is that a useful library and demo can build awareness of FILTRIX. Developer downloads and GitHub stars do not establish demand from retail traders or investors.

The demo's voluntary FILTRIX links carry only static campaign parameters:

```text
utm_source=filtrix_charts
utm_medium=demo
utm_campaign=open_beta
utm_content=studio|market|drawings|analysis|terminal|react-terminal
```

The final line describes the permitted surface values; an actual link contains exactly one of them. These are ordinary navigation URLs. The library does not send click events, identifiers or background analytics requests. A UTM parameter cannot measure a click that never reaches the destination or a conversion by itself.

The separately owned main FILTRIX product can use its existing analytics, with its own applicable consent and retention policy, to measure:

1. Visits arriving with this campaign, separated by demo surface.
2. Signups attributed to those visits.
3. A product-specific activation event selected by its owner.
4. Return usage in defined cohorts and eventual paid conversion.
5. Engineering/support hours spent on the library and demo.

Agree attribution windows and activation definitions before comparing cohorts. Review the first four weeks for signal and maintenance cost; retain, adjust or stop the experiment based on actual outcomes. No numeric conversion target or guaranteed customer growth is assumed. Instrumentation in the main product is outside this repository and has not been implemented here.
