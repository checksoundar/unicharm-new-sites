#!/usr/bin/env node
/*
 * audit-crops.js — quality gate for block reference images.
 *
 * For every variant image referenced by aem-block-inventory.json: measures luminance spread and the
 * share of near-white pixels, flags BLANK crops (≥98.5% near-white and std-dev < 10, or std-dev < 4 —
 * empty containers, embeds/videos that had not loaded, client-rendered shells), and re-encodes images
 * wider than --max-width (default 1100px, JPEG q=0.72) to keep the self-contained dashboard light.
 * Writes <CF>/crop-audit.json { "<file>": { blank, white, std, w, h } } — consolidate-aem-components.js
 * drops blank images from the galleries (variant shown as "no visual" in the classification table).
 *
 * Usage: node audit-crops.js <CF> [--max-width 1100] [--quality 0.72]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CF = path.resolve(process.argv[2] || '.');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const MAXW = +arg('--max-width', '1100');
const Q = +arg('--quality', '0.72');
const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));
const files = [...new Set(inv.inventory.flatMap((c) => c.variantList.map((v) => v.repFile)).filter(Boolean))];

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas>');
  const audit = {};
  let resized = 0;
  for (const f of files) {
    const fp = path.join(CF, 'blocks', f);
    if (!fs.existsSync(fp)) continue;
    const r = await p.evaluate(async ({ src, MAXW, Q }) => {
      const img = new Image(); img.src = src; await img.decode();
      // stats on a ≤400px-wide copy
      const sw = Math.min(img.width, 400); const shh = Math.max(1, Math.round(img.height * (sw / img.width)));
      const c = document.getElementById('c'); c.width = sw; c.height = Math.min(shh, 2000);
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, sw, shh);
      const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, sum = 0, sq = 0, white = 0;
      for (let i = 0; i < d.length; i += 16) { const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += L; sq += L * L; n++; if (L > 245) white++; }
      const mean = sum / n; const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
      let out = null;
      if (img.width > MAXW) {
        const k = MAXW / img.width; const o = document.createElement('canvas'); o.width = MAXW; o.height = Math.round(img.height * k);
        o.getContext('2d').drawImage(img, 0, 0, o.width, o.height); out = o.toDataURL('image/jpeg', Q).split(',')[1];
      }
      return { w: img.width, h: img.height, white: +(white / n).toFixed(3), std: +std.toFixed(1), out };
    }, { src: 'data:image/jpeg;base64,' + fs.readFileSync(fp).toString('base64'), MAXW, Q });
    if (r.out) { fs.writeFileSync(fp, Buffer.from(r.out, 'base64')); resized++; }
    audit[f] = { w: r.w, h: r.h, white: r.white, std: r.std, blank: (r.white >= 0.985 && r.std < 10) || r.std < 4 };
  }
  await b.close();
  fs.writeFileSync(path.join(CF, 'crop-audit.json'), JSON.stringify(audit, null, 1));
  const blank = Object.entries(audit).filter(([, a]) => a.blank).map(([f]) => f);
  console.log(`audited ${files.length} images | resized ${resized} | blank ${blank.length}`);
  blank.forEach((f) => console.log('  blank:', f));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
