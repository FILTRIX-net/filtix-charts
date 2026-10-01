# Contributing to FILTRIX Charts

FILTRIX Charts by FILTRIX.NET is available as an open-source beta under [Apache-2.0](LICENSE), selected by the owner on 2026-09-29. Contributions intended for inclusion are governed by that license. The source repository is [FILTRIX-net/filtrix-charts](https://github.com/FILTRIX-net/filtrix-charts); all nine beta packages are available on npm.

## Before proposing a change

Describe the user-visible problem, expected behavior and a small reproduction. Include the package version, browser, operating system and whether the input is synthetic or supplied by a provider. Strip credentials, account identifiers and private market data from examples. A reproducible bug is more useful than a screenshot alone.

For larger API changes, discuss the design before implementation. Keep changes focused; preserve chart/data ownership, atomic invalid-input behavior and explicit cleanup. The renderer has no external runtime dependencies. New network behavior, required accounts or telemetry require a separate product decision.

Use [GitHub issues](https://github.com/FILTRIX-net/filtrix-charts/issues) for reproducible bugs and proposals, and pull requests for focused changes. For a sensitive vulnerability, use a configured private security-reporting channel; do not post exploitable details in a public issue. No unverified support email or security-reporting URL is advertised here.

## Development

Use Node `^22.22.2 || ^24.15.0 || >=26.0.0` and npm 12.0.2:

```sh
npx --yes npm@12.0.2 ci
npm run check
npm run build:demo
```

Run focused unit tests while developing and the relevant browser tests for interaction/rendering changes. See the root README for Playwright browser setup. Add a regression test for a behavior change; documentation-only changes do not need tests that repeat their text.

Before requesting review, describe what changed, why, the checks actually run and any unresolved limits. Do not claim historical benchmark results as new measurements. Preserve raw evidence and use a new output directory for new measurements.

## Packages and scope

Package versions move together. The workspace and example stay private; distribution archives have strict inventories. See [release process](docs/RELEASE-PROCESS.md) before changing package metadata or publishing. Contributors do not need registry credentials to develop and test chart code.

The main FILTRIX application, accounts, commercial analytics and deployments are separate from this repository. A shared brand does not imply access to those systems.
