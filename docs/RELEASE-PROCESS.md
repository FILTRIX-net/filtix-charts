# FILTIX Charts beta release process

This runbook prepares `0.12.0-beta.1` for the public `beta` channel. Preparation does not publish packages or deploy a website. The root workspace and React example remain private.

## Outstanding owner inputs

The owner selected Apache-2.0 and supplied [FILTRIX-net](https://github.com/FILTRIX-net) on 2026-09-29. GitHub CLI verified `x777` as an active organization administrator. The public source destination is [FILTRIX-net/filtix-charts](https://github.com/FILTRIX-net/filtix-charts), and package metadata names that repository. Control of npm `@filtix` and registry authentication still need to be established before npm publication. GitHub organization access does not establish npm scope access.

The license file must be present in the root and in every archive, and package license identifiers must agree. Package READMEs must describe the actual available distribution. `npm run check:release` is the publication gate and must fail when these requirements are unresolved.

## Qualify local packages

Use npm 12.0.2 for lockfile changes. From the repository root:

```sh
npm run check
npm run build:demo
npm run build
npm run pack:local
npm run check:consumer
```

The beta consumer check can populate an empty npm cache by fetching the pinned npm 12.0.2 CLI and exact locked third-party dependencies from the registry; the nine FILTIX packages still install from the local archives. Allow registry access for a fresh public source checkout. Historical stage checks retain their offline cache requirement.

Review changes and commit the source before the final pack/install capture. Repeat the last three commands on that committed source and then run:

```sh
npm run check:release
```

The nine archives must agree with the committed source, exact package cohort, beta version, README/license inventory and clean installed consumer. Review the new `v0.12-beta.1` installation record. Keep old stage records intact. Do not run a historical benchmark script against a new package cohort and describe it as the old accepted release.

The publication gate does not establish account ownership, credentials or remote availability. Check those explicitly using the owner's authenticated account. Credentials and one-time passwords must not be committed or included in build logs.

## Public source repository

The development repository contains historical benchmark files over 100 MiB; the largest observed file is 451,956,516 bytes. GitHub [blocks ordinary Git files over 100 MiB](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github). Removing them only from the current tree would leave their historical blobs in the push.

Use a separately prepared, reviewed source snapshot for the initial public repository. Preserve this development repository and all its release tags. The public snapshot must include source, tests, build configuration, license and user documentation. Keep the historical audit corpus separately, with its original identities; public performance summaries must state where their evidence is available. Do not silently rewrite history or advertise missing raw evidence as publicly accessible.

Verify the exported tree independently before creating its initial commit: clean dependency installation, unit/Node checks, SDK build and demo build. A source snapshot has a new commit identity; records from the development repository do not establish clean installation against that new public commit. Generate its final package installation record on the committed public source before publishing archives from it.

## Publish the reviewed archives

After scope ownership, repository/legal metadata and the final preflight pass are confirmed, publish the exact verified `.tgz` files, not an unreviewed workspace rebuild. The required options are:

```sh
npm publish dist/packages/filtix-charts-0.12.0-beta.1.tgz --access public --tag beta
```

This is an example for one archive, not the entire release. Publish the cohort in dependency order: core, charts, indicators, datafeed, analysis, drawings, alerts, react, terminal. Inspect each result before continuing. Partial publication is possible; do not announce the whole cohort until all nine registry versions and integrity values match the candidate. Never use `latest` for this beta, and do not overwrite or move historical Git tags.

For scoped packages, public access must be explicit; see [npm's publication documentation](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [publishing a tarball](https://docs.npmjs.com/cli/v12/commands/npm-publish/). A future automated workflow can use the registry's supported authentication model after the actual repository is connected. This candidate does not install an automatic publishing workflow.

Only after successful publication, verify registry installation in a fresh consumer:

```sh
npm install @filtix/charts@0.12.0-beta.1
```

Install optional peers from the same exact beta cohort. Do not present this command as currently available before registry verification succeeds.

## Demo and announcement

Deploy only the intended public demo output to the selected hosting destination; development test and benchmark pages are not a required public site. Verify all demo routes, mobile layout, asset paths, source labels, external links and provider behavior at the actual deployed base path.

Update the README and beta report with the verified repository, npm and hosted-demo links, publication timestamps, integrity checks and known limitations. The static campaign links described in [the beta guide](OPEN-SOURCE-BETA.md#acquisition-measurement) need destination-side instrumentation to measure signups or payments; no such integration is implied by deployment.
