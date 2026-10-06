#!/usr/bin/env node
/*
 * consolidate-blocks.js — group block instances into VARIANTS per base type.
 *
 * Variant key = base type + normalized structural signature (from capture).
 * Each variant: representative instance (the one whose page has most links to it
 * = most common; here: first by page count), pagesFound, sample source URLs,
 * and a representative screenshot file.
 *
 * Outputs: block-catalog.json  and a summary to stdout.
 */
const fs = require('fs');
const path = require('path');

const CF = process.argv[2] || __dirname;
const recs = fs.readFileSync(path.join(CF, 'blocks.jsonl'), 'utf8').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.captured === true);

// normalize signature to fold trivial count differences (e.g. a3 vs a4 link counts)
function normSig(sig) {
  return (sig || '')
    .replace(/a\d/g, 'aN') // link-count bucket
    .replace(/i\d/g, 'iN'); // img-count bucket
}
const variants = {};
for (const r of recs) {
  const key = r.type + '::' + normSig(r.signature);
  const v = variants[key] || (variants[key] = { base: r.type, key, count: 0, pages: new Set(), samples: [], rep: null, labels: {} });
  v.count += 1;
  v.pages.add(r.pageUrl);
  if (v.samples.length < 6) v.samples.push({ url: r.pageUrl, file: r.file });
  if (r.label) v.labels[r.label] = (v.labels[r.label] || 0) + 1;
  // representative = largest textLen instance (most complete example)
  if (!v.rep || r.textLen > v.rep.textLen) v.rep = { file: r.file, url: r.pageUrl, textLen: r.textLen };
}
const list = Object.values(variants).map((v) => ({
  base: v.base, key: v.key,
  instances: v.count,
  pagesFound: v.pages.size,
  repFile: v.rep.file, repUrl: v.rep.url,
  samples: v.samples,
  topLabel: Object.entries(v.labels).sort((a, b) => b[1] - a[1]).slice(0, 1).map(([k]) => k)[0] || '',
})).sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : b.instances - a.instances));

// per base type summary
const byBase = {};
for (const v of list) {
  const b = byBase[v.base] || (byBase[v.base] = { base: v.base, variants: 0, instances: 0 });
  b.variants += 1; b.instances += v.instances;
}
const baseSummary = Object.values(byBase).sort((a, b) => b.instances - a.instances);

fs.writeFileSync(path.join(CF, 'block-catalog.json'), JSON.stringify({
  captured: new Date().toISOString(),
  totalInstances: recs.length,
  totalVariants: list.length,
  baseSummary,
  variants: list,
}, null, 1));

console.log('Total block instances:', recs.length);
console.log('Total variants:', list.length);
console.log('\n=== Base type -> variants / instances ===');
for (const b of baseSummary) console.log(String(b.instances).padStart(4), 'inst ', String(b.variants).padStart(3), 'variants  ', b.base);
console.log('\n=== Top 20 variants ===');
for (const v of list.slice().sort((a, b) => b.instances - a.instances).slice(0, 20)) {
  console.log(String(v.instances).padStart(4), 'x  ', v.base.padEnd(13), 'pages=' + String(v.pagesFound).padStart(3), ' ', v.key.split('::')[1].slice(0, 42));
}
