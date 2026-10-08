/*
 * fetch-map.js — load pages from somewhere other than their live URL, without changing their identity.
 *
 * <CF>/fetch-map.json = { "<live page URL>": "<URL the browser loads>" } — e.g. a file:// copy of a page
 * captured manually in a real browser (sites behind bot protection), or an archived snapshot. Every
 * artifact (pages.jsonl, aem-components.jsonl, reports) keeps the LIVE URL; only page.goto() uses the map.
 *
 * config.assetSource = "wayback": while rendering, requests to the site's own host (stylesheets, fonts,
 * images referenced by the captured DOM) are served from the Internet Archive's raw (id_) copies instead
 * of the live, protected origin, through an on-disk cache (<CF>/asset-cache/) so each asset is fetched
 * from the archive once across all pages and processes (the archive throttles bursts). Analytics / tag /
 * survey beacons are blocked so they neither fire nor inject UI. Integration detection is unaffected —
 * it reads script/iframe URLs from the DOM.
 *   SCOPE_ASSETS=css  structural passes skip images/media (the captured DOM already holds the markup).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACKERS = /hotjar|googletagmanager|google-analytics|doubleclick|googlesyndication|adobedtm|demdex|omtrdc|everesttech|snapchat|sc-static|ads-twitter|analytics\.twitter|facebook\.net|connect\.facebook|sharethis|clarity\.ms|linkedin\.com\/px|licdn|bing\.com\/bat|rum\.hlx/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadFetchMap(CF) {
  const f = path.join(CF, 'fetch-map.json');
  const map = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return (u) => map[u] || u;
}

async function fromArchive(u, cacheDir, attempts = 4, timeout = 60000) {
  const key = crypto.createHash('md5').update(u).digest('hex');
  const body = path.join(cacheDir, key);
  const meta = body + '.json';
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return m.status === 200 ? { status: 200, contentType: m.contentType, body: fs.readFileSync(body) } : { status: m.status };
  }
  let last = 0;
  for (let a = 0; a < attempts; a++) {
    try {
      const r = await fetch(`https://web.archive.org/web/2026id_/${u}`, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      last = r.status;
      if (r.status === 200) {
        const buf = Buffer.from(await r.arrayBuffer());
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        fs.writeFileSync(body, buf); fs.writeFileSync(meta, JSON.stringify({ url: u, status: 200, contentType }));
        return { status: 200, contentType, body: buf };
      }
      if (r.status === 404) break; // not archived — cache the miss
    } catch (e) { /* throttled / reset — back off */ }
    if (a < attempts - 1) await sleep(3000 * (a + 1));
  }
  if (last === 404) fs.writeFileSync(meta, JSON.stringify({ url: u, status: 404 }));
  return { status: last || 502 };
}

async function installAssetRoutes(page, CF) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')); } catch (e) { return; }
  if (cfg.assetSource !== 'wayback') return;
  const host = new URL(cfg.siteOrigin).host;
  const cacheDir = path.join(CF, 'asset-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  await page.route('**/*', async (route) => {
    const req = route.request(); const u = req.url();
    if (TRACKERS.test(u)) return route.abort();
    if (req.resourceType() === 'media') return route.abort(); // video/audio: never needed for structure or crops (posters are images)
    if (process.env.SCOPE_ASSETS === 'css' && req.resourceType() === 'image') return route.abort();
    let h = ''; try { h = new URL(u).host; } catch (e) { /* data:, file: */ }
    if (h !== host) return route.continue();
    // stylesheets/fonts are few and shared across pages → retry hard; images are many and per-page → one quick try
    const isImg = req.resourceType() === 'image';
    const r = await fromArchive(u.split('#')[0], cacheDir, isImg ? 1 : 4, isImg ? 20000 : 60000);
    if (r.status === 200) return route.fulfill({ status: 200, contentType: r.contentType, body: r.body });
    return route.fulfill({ status: 404, body: '' });
  });
}

module.exports = { loadFetchMap, installAssetRoutes };
