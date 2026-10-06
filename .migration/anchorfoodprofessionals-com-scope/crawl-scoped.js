#!/usr/bin/env node
/*
 * crawl-scoped.js — sitemap-seeded BFS crawl restricted to the in-scope properties
 * (/global/en, /dominoscolab, /yumlive). The microsites are robots-disallowed and absent
 * from every sitemap, so they can only be discovered by following links.
 * Writes .crawl.out (JSON array of {url,status,from}) for build-urls-all.js.
 */
const fs = require('fs');
const path = require('path');

const CF = __dirname;
const ORIGIN = 'https://www.anchorfoodprofessionals.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SCOPES = [/^\/global\/en(\.html|\/)/, /^\/dominoscolab(\/|\.html|$)/, /^\/yumlive(\/|\.html|$)/];
const SEEDS = [`${ORIGIN}/global/en.html`, `${ORIGIN}/dominoscolab`, `${ORIGIN}/yumlive`];
const DOC = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt)$/i;
const SKIP = /\.(jpe?g|png|gif|svg|webp|ico|css|js|woff2?|ttf|mp4|webm|json|xml)$/i;

const inScope = (p) => SCOPES.some((re) => re.test(p));
function norm(href, base) {
  try {
    const u = new URL(href, base);
    if (u.origin !== ORIGIN) return null;
    u.hash = ''; u.search = '';
    return u.href;
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      const ct = res.headers.get('content-type') || '';
      const body = /html/.test(ct) ? await res.text() : '';
      return { status: res.status, finalUrl: res.url, body, ct };
    } catch (e) { await sleep(1500 * (a + 1)); }
  }
  return { status: 0, finalUrl: url, body: '', ct: '' };
}

(async () => {
  // seed from the global/en sitemap
  const sm = await get(`${ORIGIN}/global/en/sitemap.xml`);
  const smText = sm.body || await (await fetch(`${ORIGIN}/global/en/sitemap.xml`, { headers: { 'user-agent': UA } })).text();
  const smUrls = [...smText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const sitemapSet = new Set(smUrls.map((u) => norm(u, ORIGIN)).filter(Boolean));
  const queue = [...SEEDS, ...sitemapSet];
  const seen = new Set(queue);
  const out = [];
  const from = {};
  while (queue.length) {
    const url = queue.shift();
    const p = new URL(url).pathname;
    if (DOC.test(p)) { // documents: HEAD-ish check only
      const r = await get(url);
      out.push({ url, status: r.status, from: from[url] || 'sitemap' });
      continue;
    }
    const r = await get(url);
    const rec = { url, status: r.status, from: from[url] || (sitemapSet.has(url) ? 'sitemap' : 'seed') };
    if (r.finalUrl && r.finalUrl !== url) rec.finalUrl = r.finalUrl;
    out.push(rec);
    if (r.body) {
      const hrefs = [...r.body.matchAll(/href\s*=\s*["']([^"'#][^"']*)["']/gi)].map((m) => m[1]);
      for (const h of hrefs) {
        const n = norm(h, r.finalUrl || url);
        if (!n || seen.has(n)) continue;
        const np = new URL(n).pathname;
        if (SKIP.test(np) && !DOC.test(np)) continue;
        if (!inScope(np) && !(DOC.test(np) && /\/content\/dam\//.test(np))) continue;
        seen.add(n); from[n] = url; queue.push(n);
      }
    }
    if (out.length % 25 === 0) console.error(`  crawled ${out.length}, queue ${queue.length}`);
    await sleep(250);
  }
  fs.writeFileSync(path.join(CF, '.crawl.out'), JSON.stringify(out, null, 1));
  const by = {};
  for (const o of out) { const k = o.url.replace(ORIGIN, '').split('/')[1] + ' ' + o.status; by[k] = (by[k] || 0) + 1; }
  console.log('total', out.length, 'sitemap', sitemapSet.size); console.log(by);
})();
