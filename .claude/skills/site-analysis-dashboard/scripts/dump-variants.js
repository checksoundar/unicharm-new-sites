#!/usr/bin/env node
/*
 * dump-variants.js — print every structural variant of aem-block-inventory.json with the evidence
 * needed to classify it (tag pattern, counts, flags, modifiers, data-* attributes, sample URL).
 *
 * Usage: node dump-variants.js <CF> [--skip gridlayout,container] [--width 260]
 */
const fs = require('fs');
const path = require('path');
const CF = process.argv[2];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const SKIP = new Set((arg('--skip', '') || '').split(',').filter(Boolean));
const W = +arg('--width', '260');
const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));
console.log(`pages=${inv.pages} instances=${inv.componentInstances} components=${inv.components} patterns=${inv.exactPatterns} variants=${inv.structuralVariants}`);
for (const c of inv.inventory) {
  if (SKIP.has(c.cmp)) { console.log(`\n#### ${c.cmp} inst=${c.instances} pg=${c.pages} variants=${c.variants} (skipped)`); continue; }
  console.log(`\n#### ${c.cmp}  inst=${c.instances} pg=${c.pages} patterns=${c.exactPatterns} → ${c.category}/${c.eds}${c.mapped ? '' : ' (heuristic)'}`);
  for (const v of c.variantList) {
    const f = Object.entries(v.flags).filter(([, x]) => x).map(([k, x]) => (x === true ? k : `${k}=${x}`)).join(',');
    console.log(` [${v.id}] inst=${v.instances} pg=${v.pages} h=${v.hashes.length} cnt=${JSON.stringify(v.counts)} flags=${f} ${v.repFile ? '📷' : '-'}`);
    console.log(`   mods=${v.modifiers.slice(0, 5).join(' ')} | style=${v.styles.slice(0, 4).join(' ')} | label="${v.topLabel}" | ${v.sampleUrls[0]}`);
    if (v.dataAttrs && v.dataAttrs.length) console.log(`   data: ${v.dataAttrs.join(' ')}`);
    console.log(`   P: ${v.pattern.slice(0, W)}`);
  }
}
