# FILTRIX Charts beta release process

This runbook prepares `0.12.0-beta.1` for the public `beta` channel. Preparation does not publish packages or deploy a website. The root workspace and React example remain private.

## Repository and publishing access

The repository was renamed to `FILTRIX-net/filtrix-charts` after the first beta publication. Published `0.12.0-beta.1` archives retain their original repository metadata; GitHub redirects those links. Future package versions use the corrected address. This rename does not change package names, versions or release tags.

The release uses Apache-2.0, the npm organization scope `@filtrix.net` and the source repository [FILTRIX-net/filtrix-charts](https://github.com/FILTRIX-net/filtrix-charts). Package metadata names that repository. Before publication, verify registry authentication, organization publishing rights and the account's supported publishing authentication method. GitHub organization access does not establish npm scope access.

The license file must be present in the root and in every archive, and package license identifiers must agree. Package READMEs must describe the actual available distribution. `npm run check:release` is the publication gate and must fail when these requirements are unresolved.

## Qualify local packages

### Development dependency advisory

The beta toolchain uses Vite 7.3.6 and Vitest 4.1.11. Vite resolves esbuild 0.28.2; tsup 8.5.1 retains its compatible esbuild 0.27.7 dependency. npm audit therefore still reports the low-severity [esbuild Windows development-server advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr) in the build-tool tree. Our build scripts do not use esbuild's `serve()` API. This is a recorded development-tool limitation, not a clean full-audit claim. Recheck upstream compatibility before removing it; do not force an incompatible global esbuild override. The SDK runtime dependency audit and the independent React example audit passed with zero findings at qualification.

Use npm 12.0.2 for lockfile changes. From the repository root:

```sh
npm run check
npm run build:demo
npm run build
npm run pack:local
npm run check:consumer
```

The beta consumer check can populate an empty npm cache by fetching the pinned npm 12.0.2 CLI and exact locked third-party dependencies from the registry; the nine FILTRIX packages still install from the local archives. Allow registry access for a fresh public source checkout. Historical stage checks retain their offline cache requirement.

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
npm publish dist/packages/filtrix.net-charts-0.12.0-beta.1.tgz --access public --tag beta
```

This is an example for one archive, not the entire release. Publish the cohort in dependency order: core, charts, indicators, datafeed, analysis, drawings, alerts, react, terminal. Inspect each result before continuing. Partial publication is possible; do not announce the whole cohort until all nine registry versions and integrity values match the candidate. Always request `--tag beta`; never explicitly promote a beta to `latest` or move a stable tag. Do not overwrite or move historical Git tags.

For scoped packages, public access must be explicit; see [npm's publication documentation](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [publishing a tarball](https://docs.npmjs.com/cli/v12/commands/npm-publish/). A future automated workflow can use the registry's supported authentication model after the actual repository is connected. This candidate does not install an automatic publishing workflow.

Only after successful publication, verify registry installation in a fresh consumer:

```sh
npm install @filtrix.net/charts@0.12.0-beta.1
```

Install optional peers from the same exact beta cohort. Do not present this command as currently available before registry verification succeeds.

## Published beta: 2026-09-30

All nine packages at `0.12.0-beta.1` were published from qualified public commit [c52018d](https://github.com/FILTRIX-net/filtrix-charts/commit/c52018d350e81655b0200545a717fabb475e4a4f), between 19:19 and 19:31 UTC. Registry metadata and downloaded archive hashes matched the qualified candidate for every package. A fresh consumer with an empty package cache installed all nine exact versions, verified registry integrity and ESM imports, and passed React SSR. Its dependency audit reported zero findings. [Source CI](https://github.com/FILTRIX-net/filtrix-charts/actions/runs/36752898134) passed 666 unit tests and 1017 browser tests. The build-tool advisory above remains open.

Although every publish command explicitly requested `--tag beta`, npm also assigned `latest` to the initial beta versions. The attempt to remove that alias from core returned HTTP 400. No prior stable version existed or was moved. Both tags currently resolve to `0.12.0-beta.1`; an unversioned install can therefore select this beta. Pin the exact version shown above. This release does not establish a stable API.

The registry also lists `0.0.0-stage` for alerts and terminal, with the staging-placeholder description and the same publisher account. npm [documents this placeholder for staged publication](https://docs.npmjs.com/staged-publishing/), but the commands used here were ordinary `npm publish`; the precise cause in this flow is unconfirmed. Neither distribution tag resolves to those placeholders. The integrity and installation checks above apply to the exact beta versions.

## Demo and announcement

Deploy only the intended public demo output to the selected hosting destination; development test and benchmark pages are not a required public site. Verify all demo routes, mobile layout, asset paths, source labels, external links and provider behavior at the actual deployed base path.

Update the README and beta report with the verified repository, npm and hosted-demo links, publication timestamps, integrity checks and known limitations. The static campaign links described in [the beta guide](OPEN-SOURCE-BETA.md#acquisition-measurement) need destination-side instrumentation to measure signups or payments; no such integration is implied by deployment.
