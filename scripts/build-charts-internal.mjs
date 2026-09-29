import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('../packages/charts/dist/', import.meta.url));
// Root-created charts and this entry must share exactly one capability/handle registry.
const source =
  "export { hasOwnedStudyColumnCapability, setOwnedStudyColumns, setOwnedPriceVolumeData } from './index.js';\n";
// The ordered root JS/DTS build must finish before this shim is emitted.
readFileSync(resolve(directory, 'index.js'));
readFileSync(resolve(directory, 'index.d.ts'));
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
writeFileSync(resolve(directory, 'internal.d.ts'), source);
