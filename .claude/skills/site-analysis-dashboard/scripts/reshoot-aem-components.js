#!/usr/bin/env node
/*
 * reshoot-aem-components.js — re-capture the representative screenshot of every structural
 * variant in aem-block-inventory.json with fixed/sticky overlays (sticky header, cookie bar)
 * hidden. Revisits each variant's representative page, re-runs the tag-pattern extractor,
 * finds the first visible instance with a matching component + pattern hash and overwrites
 * the variant's repFile in place (so no catalog rewiring is needed).
 *
 * Usage: node reshoot-aem-components.js <CF> [--concurrency N]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const { extractAem, hideOverlays, autoScroll } = require('./capture-aem-components.js');
const { loadFetchMap, installAssetRoutes } = require('./fetch-map.js');


const CF = process.argv[2] || '.';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CONCURRENCY = parseInt(arg('--concurrency', '3'), 10);
const CFG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8'));
const EXOPTS = { selector: CFG.componentSelector || '', ignoreClasses: CFG.ignoreClasses || [], hideSelectors: CFG.hideSelectors || [] };
const FETCH = loadFetchMap(CF);
const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));

const byPage = {};
for (const c of inv.inventory) for (const v of c.variantList) {
  if (!v.repFile) continue;
  (byPage[v.repUrl] = byPage[v.repUrl] || []).push({ cmp: c.cmp, hashes: new Set(v.hashes.map((h) => h.hash)), file: v.repFile, id: v.id });
}
const pages = Object.keys(byPage);
console.error(`reshoot: ${pages.length} pages, ${Object.values(byPage).flat().length} variants`);

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const queue = pages.slice(); let ok = 0; let miss = 0; let n = 0;
  async function worker() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: process.env.SCOPE_UA || undefined, ignoreHTTPSErrors: true });
    let page = null;
    const fresh = async () => { if (page && !page.isClosed()) await page.close().catch(() => {}); page = await ctx.newPage(); page.setDefaultTimeout(45000); await installAssetRoutes(page, CF); };
    await fresh();
    while (queue.length) {
      const url = queue.shift(); n++;
      if (page.isClosed()) await fresh(); // a crashed tab must not poison the rest of this worker's queue
      try {
        await page.goto(FETCH(url), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {}); // don't let slow images drop the page
        await page.waitForTimeout(800); await autoScroll(page); await page.waitForTimeout(1200);
        const data = await page.evaluate(extractAem, EXOPTS);
        for (const t of byPage[url]) {
          const hit = data.recs.find((r) => r.cmp === t.cmp && r.visible && t.hashes.has(crypto.createHash('md5').update(r.cmp + '|' + r.pattern).digest('hex').slice(0, 10)));
          if (!hit) { miss++; continue; }
          try {
            const file = path.join(CF, 'blocks', t.file);
            await page.evaluate(hideOverlays, { id: hit.tagId, extra: EXOPTS.hideSelectors }).catch(() => {});
            if (t.cmp === 'header') {
              // fixed-position header: the XF box is ~0px tall, so clip the top of the viewport instead
              await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
              const hb = await page.evaluate((id) => { const el = document.querySelector(`[data-sadblk="${id}"]`); let b = 0; for (const n of el.querySelectorAll('*')) { const r = n.getBoundingClientRect(); if (r.height > 0 && r.top < 400 && getComputedStyle(n).visibility !== 'hidden') b = Math.max(b, r.bottom); } return Math.ceil(b); }, hit.tagId);
              await page.screenshot({ path: file, type: 'jpeg', quality: 75, clip: { x: 0, y: 0, width: 1440, height: Math.min(400, Math.max(80, hb)) } });
            } else {
              await page.locator(`[data-sadblk="${hit.tagId}"]`).first().screenshot({ path: file, type: 'jpeg', quality: 75, timeout: 30000, animations: 'disabled' });
            }
            ok++;
          } catch (e) { miss++; if (process.env.SCOPE_DEBUG) console.error('  shot-miss', t.id, (e.message || '').split('\n')[0].slice(0, 100)); }
        }
      } catch (e) { miss += byPage[url].length; if (/closed|crash/i.test(e.message || '')) await fresh().catch(() => {}); console.error('  page-miss', url.slice(-60), (e.message || '').split('\n')[0].slice(0, 100)); }
      if (n % 20 === 0) console.error(`  ${n}/${pages.length} pages ok=${ok} miss=${miss}`);
    }
    await ctx.close();
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  console.error(`DONE reshoot ok=${ok} miss=${miss}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
