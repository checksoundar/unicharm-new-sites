#!/usr/bin/env node
/*
 * crawl-scoped.js — config-driven, sitemap-seeded BFS crawl restricted to in-scope path
 * prefixes. Use instead of the generic crawler when the scope is a subset of a domain,
 * when sections are robots-disallowed / unsitemapped (microsites), or when the sitemap is
 * incomplete. Writes <CF>/.crawl.out (JSON array of {url,status,from,finalUrl?}) for
 * build-urls-all.js, plus <CF>/aem-endpoints.json (AEM Sling component endpoints such as
 * _jcr_content/...html, set aside — they are AJAX fragments, not pages).
 *
 * config.json:
 *   "crawl": {
 *     "sitemaps": ["https://x/sitemap.xml"],      // sitemap or sitemap-index URLs (seeded, recursive)
 *     "seeds":    ["https://x/en.html"],          // extra start URLs
 *     "scopes":   ["^/en(\\.html|/)", "^/micro"],  // pathname regexes that are in scope (default: all)
 *     "exclude":  ["^/en/myaccount"],             // pathname regexes to skip entirely
 *     "concurrency": 4, "delay": 150, "maxPages": 20000
 *   }
 * Off-site redirects are recorded with status 301 so they are not rendered.
 *
 * Usage: node crawl-scoped.js <CF>
 */
const fs = require('fs');
const path = require('path');

const CF = process.argv[2] || '.';
const CFG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8'));
const C = CFG.crawl || {};
const ORIGIN = CFG.siteOrigin;
const UA = process.env.SCOPE_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SCOPES = (C.scopes || []).map((s) => new RegExp(s));
const EXCL = (C.exclude || []).map((s) => new RegExp(s));
const CONC = C.concurrency || 4;
const DELAY = C.delay ?? 150;
const MAX = C.maxPages || 20000;
const DOC = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt)$/i;
const SKIP = /\.(jpe?g|png|gif|svg|webp|ico|css|js|woff2?|ttf|mp4|webm|json|xml|mp3)$/i;
const hosts = new Set([new URL(ORIGIN).host, ...(C.extraHosts || [])]);

const inScope = (p) => (!SCOPES.length || SCOPES.some((re) => re.test(p))) && !EXCL.some((re) => re.test(p));
function norm(href, base) {
  try {
    const u = new URL(href, base);
    if (!hosts.has(u.host) || !/^https?:$/.test(u.protocol)) return null;
    u.hash = ''; u.search = ''; u.protocol = new URL(ORIGIN).protocol; u.host = new URL(ORIGIN).host;
    return u.href;
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, wantBody = true) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      const ct = res.headers.get('content-type') || '';
      const body = wantBody && /html|xml/.test(ct) ? await res.text() : (res.body && res.body.cancel ? (res.body.cancel(), '') : '');
      return { status: res.status, finalUrl: res.url, body, ct };
    } catch (e) { await sleep(1500 * (a + 1)); }
  }
  return { status: 0, finalUrl: url, body: '', ct: '' };
}
async function sitemapUrls(u, depth = 0, out = new Set()) {
  const r = await get(u);
  const locs = [...(r.body || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex/i.test(r.body) && depth < 3) { for (const l of locs) await sitemapUrls(l, depth + 1, out); } else locs.forEach((l) => out.add(l));
  return out;
}

(async () => {
  const smSet = new Set();
  for (const s of C.sitemaps || []) (await sitemapUrls(s)).forEach((u) => { const n = norm(u, ORIGIN); if (n && inScope(new URL(n).pathname)) smSet.add(n); });
  const seeds = (C.seeds || [CFG.siteUrl || ORIGIN]).map((s) => norm(s, ORIGIN)).filter(Boolean);
  const queue = [...new Set([...seeds, ...smSet])];
  const seen = new Set(queue); const from = {};
  const out = []; const endpoints = [];
  console.error(`sitemap URLs in scope: ${smSet.size}; seeds: ${seeds.length}`);
  async function worker() {
    while (queue.length && out.length + endpoints.length < MAX) {
      const url = queue.shift();
      const p = new URL(url).pathname;
      const r = await get(url, !DOC.test(p));
      const rec = { url, status: r.status, from: from[url] || (smSet.has(url) ? 'sitemap' : 'seed') };
      if (r.finalUrl && r.finalUrl.replace(/[?#].*$/, '') !== url) {
        rec.finalUrl = r.finalUrl;
        try { if (!hosts.has(new URL(r.finalUrl).host)) rec.status = 301; } catch (e) { /* keep */ }
      }
      if (p.includes('/_jcr_content/')) endpoints.push(rec); else out.push(rec);
      if (r.body && /html/.test(r.ct) && rec.status === 200) {
        for (const m of r.body.matchAll(/href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
          const n = norm(m[1].replace(/&amp;/g, '&'), r.finalUrl || url);
          if (!n || seen.has(n)) continue;
          const np = new URL(n).pathname;
          if (SKIP.test(np) && !DOC.test(np)) continue;
          if (!inScope(np) && !(DOC.test(np) && /\/content\/dam\//.test(np))) continue;
          seen.add(n); from[n] = url; queue.push(n);
        }
      }
      const done = out.length + endpoints.length;
      if (done % 100 === 0) console.error(`  crawled ${done}, queue ${queue.length}`);
      if (DELAY) await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(path.join(CF, '.crawl.out'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(CF, 'aem-endpoints.json'), JSON.stringify(endpoints, null, 1));
  const by = {};
  for (const o of out) { const seg = new URL(o.url).pathname.split('/').filter(Boolean); const k = (seg.slice(0, 2).join('/') || '/') + ' ' + o.status; by[k] = (by[k] || 0) + 1; }
  console.log(`total ${out.length} (+${endpoints.length} component endpoints), sitemap ${smSet.size}`);
  console.log(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v}\t${k}`).join('\n'));
})();
