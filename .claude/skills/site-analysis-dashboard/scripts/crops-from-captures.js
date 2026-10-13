#!/usr/bin/env node
/*
 * crops-from-captures.js — block reference images cut from the user's LIVE desktop screenshots.
 *
 * For manually captured sites (captures.json: live URL → desktop/mobile PNG + rendered DOM) the local
 * re-render of the captured DOM can lack page-specific CSS or images, while the user's screenshot shows
 * the real page. Once the local layout matches the screenshot, every block's box measured locally maps
 * onto the screenshot, so the reference image can be cut from the live capture instead.
 *
 *  1. parity pass  — render each captured page at its screenshot width; parity = localHeight/shotHeight
 *                    (cached in parity.json)
 *  2. per variant  — among the pages containing the variant (any of its pattern hashes) that have a
 *                    desktop capture, pick the best-parity page (≤ MAX_DRIFT, repUrl preferred on ties)
 *  3. crop         — measure the block's box locally; refine the vertical offset (±REFINE px) by matching
 *                    a downscaled strip of the local render against the screenshot; cut the box from the
 *                    screenshot → blocks/cap_<cmp>_<hash>.jpg
 *  4. crop-overrides.json  {"<cmp>|<firstHash>": {file, url, parity, offset}} — consolidate-aem-components
 *                    uses it for the variant's repFile / repUrl. Variants without a parity page keep their
 *                    re-rendered crop.
 *
 * Usage: node crops-from-captures.js <CF> [--concurrency 3] [--max-drift 0.03] [--refine 160]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const { extractAem } = require('./capture-aem-components.js');
const { loadFetchMap, installAssetRoutes } = require('./fetch-map.js');

const CF = path.resolve(process.argv[2] || '.');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CONC = +arg('--concurrency', '3');
const MAX_DRIFT = +arg('--max-drift', '0.03');
const REFINE = +arg('--refine', '160');
const CFG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8'));
const EXOPTS = { selector: CFG.componentSelector || '', ignoreClasses: CFG.ignoreClasses || [] };
const caps = JSON.parse(fs.readFileSync(path.join(CF, 'captures.json'), 'utf8'));
const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));
const FETCH = loadFetchMap(CF);
const pngSize = (f) => { const b = Buffer.alloc(24); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const hashOf = (r) => crypto.createHash('md5').update(r.cmp + '|' + r.pattern).digest('hex').slice(0, 10);

// pages containing each pattern hash (from the full instance capture)
const pagesByHash = {};
for (const l of fs.readFileSync(path.join(CF, 'aem-components.jsonl'), 'utf8').split('\n')) {
  if (!l) continue; let r; try { r = JSON.parse(l); } catch (e) { continue; }
  const k = r.cmp + '|' + r.hash; (pagesByHash[k] = pagesByHash[k] || new Set()).add(r.pageUrl);
}

async function pool(items, fn) { const q = items.slice(); await Promise.all(Array.from({ length: CONC }, async () => { while (q.length) await fn(q.shift()); })); }
async function openPage(browser, url) {
  const sz = pngSize(path.join(CF, caps[url].desktop));
  const page = await browser.newPage({ viewport: { width: sz.w, height: 1000 } });
  await installAssetRoutes(page, CF);
  await page.goto(FETCH(url), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { page, sz };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] }); // canvas reads of file:// screenshots
  // ---------- 1. parity ----------
  const pf = path.join(CF, 'parity.json');
  const parity = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : {};
  const todo = Object.keys(caps).filter((u) => caps[u].desktop && parity[u] === undefined);
  let n = 0;
  await pool(todo, async (u) => {
    try {
      const { page, sz } = await openPage(browser, u);
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      parity[u] = +(h / sz.h).toFixed(4);
      await page.close();
    } catch (e) { parity[u] = null; }
    if (++n % 25 === 0) { console.error(`  parity ${n}/${todo.length}`); fs.writeFileSync(pf, JSON.stringify(parity, null, 1)); }
  });
  fs.writeFileSync(pf, JSON.stringify(parity, null, 1));
  const good = Object.values(parity).filter((r) => r && Math.abs(r - 1) <= MAX_DRIFT).length;
  console.error(`parity: ${good}/${Object.keys(parity).length} pages within ±${MAX_DRIFT * 100}%`);

  // ---------- 2. candidate pages per variant (best parity first) ----------
  const cands = {}; // key -> { t, list }
  let noPage = 0;
  for (const c of inv.inventory) for (const v of c.variantList) {
    const hashes = v.hashes.map((h) => h.hash);
    const list = [...new Set(hashes.flatMap((h) => [...(pagesByHash[c.cmp + '|' + h] || [])]))]
      .filter((u) => caps[u] && caps[u].desktop && parity[u] && Math.abs(parity[u] - 1) <= MAX_DRIFT)
      .sort((a, b) => (Math.abs(parity[a] - 1) - Math.abs(parity[b] - 1)) || ((b === v.repUrl) - (a === v.repUrl)));
    if (!list.length) { noPage++; continue; }
    cands[c.cmp + '|' + hashes[0]] = { t: { key: c.cmp + '|' + hashes[0], cmp: c.cmp, hashes: new Set(hashes), id: v.id }, list };
  }
  console.error(`variants: ${Object.keys(cands).length} with a parity page, ${noPage} without one (keep re-rendered crop)`);

  // ---------- 3. crop from the screenshot — round r tries each uncropped variant's r-th candidate page
  //          (a block can be hidden at desktop width on one page, e.g. an inactive tab, but shown on another)
  const of = path.join(CF, 'crop-overrides.json');
  const overrides = {};
  let ok = 0; let skip = 0;
  for (let round = 0; round < 4; round++) {
    const plan = {};
    for (const [k, x] of Object.entries(cands)) if (!overrides[k] && x.list[round]) (plan[x.list[round]] = plan[x.list[round]] || []).push(x.t);
    if (!Object.keys(plan).length) break;
    n = 0;
    await pool(Object.keys(plan), async (url) => {
      let page; let sz;
      try { ({ page, sz } = await openPage(browser, url)); } catch (e) { skip += plan[url].length; return; }
      try {
        const data = await page.evaluate(extractAem, EXOPTS);
        const shotPath = path.join(CF, caps[url].desktop);
        for (const t of plan[url]) {
          const hit = data.recs.find((r) => r.cmp === t.cmp && t.hashes.has(hashOf(r)) && r.box.h >= 12 && r.box.w >= 40)
            || (t.cmp === 'header' ? data.recs.find((r) => r.cmp === 'header') : null);
          if (!hit) { skip++; continue; }
          // absolute box (page coords) — fixed header is cropped from the top of the capture
          let box = await page.evaluate((id) => { const el = document.querySelector(`[data-sadblk="${id}"]`); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }, hit.tagId);
          if (t.cmp === 'header') box = { x: 0, y: 0, w: sz.w, h: Math.max(80, Math.min(160, await page.evaluate(() => { let b = 0; for (const n of document.querySelectorAll('header *, .cmp-experiencefragment--header *')) { const r = n.getBoundingClientRect(); if (r.height > 0 && r.top < 300) b = Math.max(b, r.bottom); } return Math.ceil(b); }))) };
          if (box.h < 12 || box.w < 40) { skip++; continue; }
          box = { x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)), w: Math.round(Math.min(box.w, sz.w - box.x)), h: Math.round(Math.min(box.h, 2400, sz.h - box.y)) };
          if (box.h < 12) { skip++; continue; }
          // local strip (template for offset refinement)
          const strip = { x: box.x, y: box.y, w: box.w, h: Math.min(box.h, 260) };
          const tpl = (await page.screenshot({ type: 'jpeg', quality: 60, clip: { x: strip.x, y: strip.y, width: strip.w, height: strip.h }, fullPage: true })).toString('base64');
          // refine + crop in a scratch page that holds the full screenshot
          // refine only where the layout can actually have drifted: exact-parity pages are trusted as measured;
          // otherwise the search window is capped by the drift the parity implies at this depth (+40px)
          const drift = Math.abs(parity[url] - 1);
          const window = drift <= 0.002 ? 0 : Math.min(REFINE, Math.round(drift * box.y) + 40);
          const res = await cropFromShot(browser, shotPath, tpl, box, strip, window);
          if (!res) { skip++; continue; }
          const file = `cap_${t.cmp.replace(/[^a-z0-9-]/gi, '')}_${[...t.hashes][0]}.jpg`;
          fs.writeFileSync(path.join(CF, 'blocks', file), Buffer.from(res.jpg, 'base64'));
          overrides[t.key] = { file, url, parity: parity[url], offset: res.offset, score: res.score };
          ok++;
        }
      } catch (e) { console.error('  page error', url.slice(-60), (e.message || '').split('\n')[0].slice(0, 90)); skip += plan[url].length; }
      await page.close().catch(() => {});
      if (++n % 20 === 0) console.error(`  round ${round + 1}: ${n}/${Object.keys(plan).length} pages ok=${ok}`);
    });
    console.error(`round ${round + 1}: ${Object.keys(overrides).length} variants cropped so far`);
  }
  skip = Object.keys(cands).length - Object.keys(overrides).length;
  fs.writeFileSync(of, JSON.stringify(overrides, null, 1));
  await browser.close();
  console.error(`DONE crops from captures: ${ok} written, ${skip} variants not visible on any parity page, ${noPage} without a parity page`);

  // downscaled template matching on a canvas: best vertical offset within ±refine px, then crop
  async function cropFromShot(br, shotPath, tplB64, box, strip, refine) {
    const sp = await br.newPage();
    try {
      await sp.goto('file://' + shotPath);
      return await sp.evaluate(async ({ tplB64, box, strip, refine }) => {
        const shot = document.querySelector('img'); await shot.decode();
        const tpl = new Image(); tpl.src = 'data:image/jpeg;base64,' + tplB64; await tpl.decode();
        const S = 0.25; // match at quarter scale
        const tw = Math.max(8, Math.round(strip.w * S)); const th = Math.max(4, Math.round(strip.h * S));
        const c1 = document.createElement('canvas'); c1.width = tw; c1.height = th;
        const g1 = c1.getContext('2d'); g1.drawImage(tpl, 0, 0, tw, th);
        const T = g1.getImageData(0, 0, tw, th).data;
        const y0 = Math.max(0, strip.y - refine); const y1 = Math.min(shot.naturalHeight - strip.h, strip.y + refine);
        const sh = Math.max(th, Math.round((y1 - y0 + strip.h) * S));
        const c2 = document.createElement('canvas'); c2.width = tw; c2.height = sh;
        const g2 = c2.getContext('2d'); g2.drawImage(shot, strip.x, y0, strip.w, (y1 - y0 + strip.h), 0, 0, tw, sh);
        const W = g2.getImageData(0, 0, tw, sh).data;
        const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const mad = (off) => { let s = 0; let k = 0; for (let y = 0; y < th; y += 2) for (let x = 0; x < tw; x += 2) { const a = (y * tw + x) * 4; const b = ((y + off) * tw + x) * 4; s += Math.abs(lum(T, a) - lum(W, b)); k++; } return s / k; };
        const base = Math.round((strip.y - y0) * S);
        let best = base; let bestS = mad(base); const baseS = bestS;
        // a flat (low-contrast) template cannot be matched reliably — keep the measured position
        let m = 0; let m2 = 0; let k = 0; for (let i = 0; i < T.length; i += 16) { const L = lum(T, i); m += L; m2 += L * L; k++; }
        const flat = Math.sqrt(m2 / k - (m / k) ** 2) < 18;
        if (refine > 0 && !flat) for (let o = 0; o + th <= sh; o++) { const s = mad(o); if (s < bestS) { bestS = s; best = o; } }
        // only move if the match is clearly better than the measured position
        const offPx = bestS < baseS * 0.85 ? Math.round((best - base) / S) : 0;
        const cy = Math.max(0, Math.min(shot.naturalHeight - box.h, box.y + offPx));
        const out = document.createElement('canvas'); out.width = box.w; out.height = box.h;
        out.getContext('2d').drawImage(shot, box.x, cy, box.w, box.h, 0, 0, box.w, box.h);
        return { jpg: out.toDataURL('image/jpeg', 0.8).split(',')[1], offset: offPx, score: +bestS.toFixed(1) };
      }, { tplB64, box, strip, refine });
    } catch (e) { return null; } finally { await sp.close().catch(() => {}); }
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
