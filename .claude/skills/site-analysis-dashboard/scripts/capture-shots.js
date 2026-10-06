#!/usr/bin/env node
/*
 * capture-shots.js — full-page screenshot of one representative page per layout template.
 * Fresh Chromium (picks up CJK font). Locale-aware. Resumable (skips existing files).
 * Writes JPEGs to <CF>/shots/<name>__<idx>.jpg and a manifest shots.json.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CF = process.argv[2] || __dirname;
const layouts = JSON.parse(fs.readFileSync(path.join(CF, 'layouts.json'), 'utf8')).templates;
const SHOTS = path.join(CF, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// prefer an https URL (http:// sample URLs redirect and hang), upgrade if needed
function pickUrl(urls) {
  const https = (urls || []).find((u) => u.startsWith('https://'));
  return (https || (urls || [])[0] || '').replace(/^http:\/\//, 'https://');
}
// one representative URL per template (first member)
let targets = layouts.map((t, i) => ({
  idx: i, name: t.name, family: t.family, signature: t.signature, estPop: t.estPop,
  url: pickUrl(t.urls), file: `t${String(i).padStart(2, '0')}_${t.name}.jpg`,
}));
// the dashboard shows one shot per family (highest estPop). Capturing all 508 templates
// would hammer the origin, so keep the top few per family (SHOTS_PER_FAMILY, default 2).
const perFam = parseInt(process.env.SHOTS_PER_FAMILY || '2', 10);
const famCount = {};
targets.sort((a, b) => (b.estPop || 0) - (a.estPop || 0));
targets = targets.filter((t) => {
  const k = t.family || t.name;
  famCount[k] = (famCount[k] || 0) + 1;
  return famCount[k] <= perFam;
});

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0; const step = 700;
      const t = setInterval(() => { window.scrollBy(0, step); y += step; if (y >= document.body.scrollHeight + 1000) { clearInterval(t); res(); } }, 80);
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const ctx = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, userAgent: process.env.SCOPE_UA || undefined, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  const manifest = [];
  for (const t of targets) {
    const out = path.join(SHOTS, t.file);
    if (fs.existsSync(out) && fs.statSync(out).size > 5000) { manifest.push({ ...t, captured: true, skipped: true }); continue; }
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(800);
      await autoScroll(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: out, fullPage: true, type: 'jpeg', quality: 78 });
      const sz = fs.statSync(out).size;
      manifest.push({ ...t, captured: true, bytes: sz });
      console.error(`✓ ${t.file}  (${Math.round(sz / 1024)}KB)  ${t.url.slice(0, 60)}`);
    } catch (e) {
      manifest.push({ ...t, captured: false, error: (e.message || '').slice(0, 120) });
      console.error(`✗ ${t.file}  ${(e.message || '').slice(0, 80)}`);
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(CF, 'shots.json'), JSON.stringify({ captured: new Date().toISOString(), shots: manifest }, null, 1));
  const okc = manifest.filter((m) => m.captured).length;
  console.error(`DONE shots: ${okc}/${targets.length}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
