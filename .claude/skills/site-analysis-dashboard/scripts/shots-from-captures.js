#!/usr/bin/env node
/*
 * shots-from-captures.js — page-template previews from MANUAL captures instead of re-rendering.
 *
 * For sites captured by hand (bot-protected origins), <CF>/captures.json maps each live URL to the
 * user's full-page desktop/mobile screenshots. For every layout family in layouts.json this picks the
 * representative page (first family URL that has both captures), composes desktop + mobile side by side
 * into <CF>/shots/<file>.jpg, and writes shots.json in the same schema as capture-shots.js, so
 * build-dashboard.js shows them as the Page Templates previews.
 *
 * Usage: node shots-from-captures.js <CF> [--max-height 7000]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CF = path.resolve(process.argv[2] || '.'); // absolute: file:// URLs below
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const MAXH = +arg('--max-height', '7000');
const caps = JSON.parse(fs.readFileSync(path.join(CF, 'captures.json'), 'utf8'));
const layouts = JSON.parse(fs.readFileSync(path.join(CF, 'layouts.json'), 'utf8')).templates;
const SHOTS = path.join(CF, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// family → candidate URLs, most populous signature first
const fam = {};
for (const t of layouts.slice().sort((a, b) => b.estPop - a.estPop)) {
  const f = fam[t.name] || (fam[t.name] = { name: t.name, family: t.family, estPop: 0, urls: [] });
  f.estPop += t.estPop; f.urls.push(...t.urls);
}
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1340, height: 1000 } });
  const manifest = [];
  let i = 0;
  for (const f of Object.values(fam)) {
    const url = f.urls.find((u) => caps[u] && caps[u].desktop && caps[u].mobile) || f.urls.find((u) => caps[u] && caps[u].desktop);
    const file = `t${String(i++).padStart(2, '0')}_${f.name}.jpg`;
    if (!url) { manifest.push({ name: f.name, family: f.family, estPop: f.estPop, file, captured: false, error: 'no capture' }); continue; }
    const d = 'file://' + path.join(CF, caps[url].desktop); const m = caps[url].mobile ? 'file://' + path.join(CF, caps[url].mobile) : '';
    const html = `<html><body style="margin:0;background:#e9eaee;font:13px sans-serif">
      <div style="display:flex;gap:20px;align-items:flex-start;padding:16px">
        <div><div style="font-weight:600;margin-bottom:6px">Desktop</div><img src="${d}" style="width:960px;display:block;box-shadow:0 1px 6px #0003"></div>
        ${m ? `<div><div style="font-weight:600;margin-bottom:6px">Mobile</div><img src="${m}" style="width:300px;display:block;box-shadow:0 1px 6px #0003"></div>` : ''}
      </div></body></html>`;
    const tmp = path.join(SHOTS, '_compose.html');
    fs.writeFileSync(tmp, html);
    try {
      await page.goto('file://' + tmp, { waitUntil: 'load', timeout: 120000 });
      const h = await page.evaluate(() => document.body.scrollHeight);
      await page.screenshot({ path: path.join(SHOTS, file), type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: 1340, height: Math.min(MAXH, h) } });
      manifest.push({ name: f.name, family: f.family, estPop: f.estPop, url, file, captured: true, source: 'manual-capture', desktop: caps[url].desktop, mobile: caps[url].mobile });
      console.error(`✓ ${file}  ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    } catch (e) {
      manifest.push({ name: f.name, family: f.family, estPop: f.estPop, url, file, captured: false, error: (e.message || '').slice(0, 120) });
      console.error(`✗ ${file}  ${(e.message || '').slice(0, 80)}`);
    }
  }
  fs.rmSync(path.join(SHOTS, '_compose.html'), { force: true });
  await browser.close();
  fs.writeFileSync(path.join(CF, 'shots.json'), JSON.stringify({ captured: new Date().toISOString(), source: 'manual-capture', shots: manifest }, null, 1));
  console.error(`DONE shots: ${manifest.filter((x) => x.captured).length}/${manifest.length}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
