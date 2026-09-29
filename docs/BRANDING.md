# FILTIX Charts by FILTIX.net

The public product name is **FILTIX Charts**, with the attribution **by FILTIX.net**. This presentation was approved on 2026-09-29. The library is preparing its first open-source beta; BETA labels describe the candidate and do not imply public package publication or hosted availability.

## Visible identity

- Use the existing angular F mark, followed by FILTIX and CHARTS on one line, with `by FILTIX.net` underneath. Keep the attribution visible on narrow screens.
- Link the header identity to the current application's home. Link the footer attribution to `https://filtix.net` in a separate tab.
- Use `FILTIX Charts — <screen> | FILTIX.net` for application page titles. Descriptions name the product and its owner.
- Keep the dark graphite surface and pale green accent. The mark uses `#c7ee92` on dark surfaces and the existing `#52742d` accent on light surfaces. The lockup uses Bahnschrift/Trebuchet MS with a monospace CHARTS label; no external font request is needed.
- The favicon uses the same F path on a graphite tile. The identical files in the showcase and independent React example keep each application self-contained.

## Version and scope

The showcase's Vite HTML transform reads the root `package.json` version; the React example imports the version from its own `package.json`. This also works when the example runs through the root browser-test server. Display the full version and use the BETA designation. Update each application's package metadata as part of a future release rather than hardcoding version strings into headers.

Brand assets and styles belong to the demo applications. Embedded charts do not acquire a mandatory logo, attribution or watermark through this change. The SDK's host styling and original saved-data contracts remain intact.

The package scope `@filtix`, saved-data keys and schema identifiers are compatibility contracts. Changing them requires an explicit migration; they must not be mechanically renamed as part of a branding update.

Historical release reports, screenshots, benchmark records and the accepted `v0.11.0` tag retain their original bytes. New branding verification is recorded separately; it does not replace the measured release or claim new engine performance.
