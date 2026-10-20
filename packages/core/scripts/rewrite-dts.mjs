// tsc (5.9) keeps "./x.ts" specifiers in emitted .d.ts files, which consumers
// without allowImportingTsExtensions cannot resolve. Rewrite them to "./x.js".
// Usage: node scripts/rewrite-dts.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: rewrite-dts.mjs <dir>');
let files = 0;
let rewritten = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.d.ts')) {
      files++;
      const src = fs.readFileSync(p, 'utf8');
      const out = src.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g, '$1$2.js$1');
      if (out !== src) { rewritten++; fs.writeFileSync(p, out); }
    }
  }
})(root);
console.log(`rewrite-dts: ${rewritten} of ${files} declaration files updated in ${root}`);
