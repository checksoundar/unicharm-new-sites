#!/usr/bin/env node
/*
 * contact-sheet.js — render a labelled grid of variant screenshots from aem-block-inventory.json
 * into one JPEG, for the human/agent evidence review that precedes writing block-mapping.json.
 *
 * Usage: node contact-sheet.js <CF> <out.jpg> [variantId,variantId,...|all] [--cols 3]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const [CF, OUT, IDS = 'all'] = process.argv.slice(2);
const cols = +((process.argv.indexOf('--cols') > 0 && process.argv[process.argv.indexOf('--cols') + 1]) || 3);
const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));
const vs = [];
for (const c of inv.inventory) for (const v of c.variantList) if (v.repFile && (IDS === 'all' || IDS.split(',').includes(v.id))) vs.push(v);
let h = `<html><body style="margin:0;font:12px sans-serif;display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;width:1500px;background:#ddd">`;
for (const v of vs) {
  const b = fs.readFileSync(path.join(CF, 'blocks', v.repFile)).toString('base64');
  h += `<div style="background:#fff"><div style="background:#222;color:#fff;padding:2px 4px">${v.id} · ${v.instances} inst · ${v.pages} pg</div><img src="data:image/jpeg;base64,${b}" style="width:100%;max-height:330px;object-fit:contain;object-position:top"></div>`;
}
h += '</body></html>';
(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 1500, height: 800 } });
  await p.setContent(h); await p.waitForTimeout(300);
  await p.screenshot({ path: OUT, fullPage: true, type: 'jpeg', quality: 60 });
  await br.close();
  console.log(`${OUT}: ${vs.length} variants`);
})();
