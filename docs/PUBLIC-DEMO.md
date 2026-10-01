# Public demo deployment

Live showcase: [charts.filtrix.net](https://charts.filtrix.net/). Studio, Market, Study, Analysis and Terminal are available over HTTPS.

The public showcase is a static website. Studio, Study and Analysis use labelled synthetic data; Market and Terminal request public Binance Spot data directly from the browser. Provider availability can vary. Saved demo settings remain in the browser.

## Build and verify

```sh
npm run build:demo:public
npm run check:demo:public
npm run test:demo:public
```

The output is `dist/public-demo`: five HTML pages, bundled assets and the brand icon. The build excludes development benchmarks and test pages, and removes their navigation links. Relative URLs support a domain root and a project path such as `/filtrix-charts/`. The regular `npm run build:demo` retains the development showcase in `dist/showcase`.

The browser check starts and stops its own preview servers, verifies both hosting paths on desktop plus the project path on mobile, and simulates successful and unavailable market data. It requires Playwright Chromium, or installed Chrome on local Windows. Set `FILTRIX_DEMO_TEST_PORT` to choose the first of two adjacent preview ports.

## GitHub Pages

Enable Pages with **GitHub Actions** as the build source. The `checks` workflow builds and verifies the public artifact alongside the SDK checks. Only successful runs on `main` upload `dist/public-demo` and deploy it through the `github-pages` environment. Pull requests run the checks without deploying. New runs cancel superseded checks for the same ref; serialized deployments also check the current `main` SHA so rerunning an older revision cannot roll the site back. The deployment uses GitHub's short-lived OIDC credentials; no deployment token is committed.

For a custom subdomain, verify the domain for the repository's organization, add the custom hostname in repository Pages settings, then point that subdomain's CNAME to the organization's `github.io` hostname. Keep the verification TXT record. Enable enforced HTTPS after GitHub issues the certificate. See [GitHub custom-domain setup](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

After deployment, verify the five routes, navigation, source labels, external links, provider error states and HTTPS at the actual URL before announcing availability. The website deployment does not publish or update npm packages.
