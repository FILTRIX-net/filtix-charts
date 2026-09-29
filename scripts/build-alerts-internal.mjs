import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('../packages/alerts/dist/', import.meta.url));
// One root bundle owns the store/monitor WeakMaps. The internal entry must reuse it.
const source =
  "export { prepareAlertMembershipReplacement, preparePriceAlertStoreRestore, getPriceAlertStoreResourceSnapshot, getPriceAlertMonitorResourceSnapshot } from './index.js';\n";
const declaration =
  source +
  "export type { PreparedAlertMembership, PreparedPriceAlertStoreRestore, PriceAlertStoreResourceSnapshot, PriceAlertMonitorResourceSnapshot } from './index.js';\n";
// Emit the shim only after the ordered root JS and declaration builds have completed.
readFileSync(resolve(directory, 'index.js'));
readFileSync(resolve(directory, 'index.d.ts'));
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'internal.js'), source + '//# sourceMappingURL=internal.js.map\n');
writeFileSync(
  resolve(directory, 'internal.js.map'),
  JSON.stringify({
    version: 3,
    file: 'internal.js',
    sources: ['internal-entry.js'],
    sourcesContent: [source],
    names: [],
    mappings: 'AAAA',
  }) + '\n',
);
writeFileSync(resolve(directory, 'internal.d.ts'), declaration);
