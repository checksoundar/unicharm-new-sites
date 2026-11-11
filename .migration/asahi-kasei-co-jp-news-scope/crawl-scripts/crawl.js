// Crawl asahi-kasei.co.jp news indexes 2006-2014 (jp+en), then fetch each linked page once (depth 1).
const fs = require('fs');
const BASE = 'https://www.asahi-kasei.co.jp';
const OUT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (EDS migration scope crawl)' }, redirect: 'manual' });
      const loc = r.headers.get('location');
      const ct = r.headers.get('content-type') || '';
      const len = r.headers.get('content-length');
      let body = null;
      if (ct.includes('html')) body = Buffer.from(await r.arrayBuffer()); else { try { await r.body?.cancel(); } catch {} }
      return { status: r.status, loc, ct, len, body };
    } catch (e) { await sleep(1000); }
  }
  return { status: 0 };
}
function decode(buf, ct) {
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const m = buf.toString('latin1').match(/charset=["']?([\w-]+)/i); cs = m && m[1]; }
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}
function links(html, pageUrl) {
  const out = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim().split('#')[0];
    if (!raw) continue;
    try { const u = new URL(raw, pageUrl); if (/^https?:$/.test(u.protocol)) out.add(u.href); } catch {}
  }
  return [...out];
}
const title = (h) => ((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
(async () => {
  const indexes = [];
  for (const loc of ['jp', 'en']) for (let y = 2006; y <= 2014; y++) for (const t of ['', 'press.html', 'ir.html', 'csr.html']) indexes.push(`${BASE}/asahi/${loc}/news/${y}/${t}`);
  const pages = {};
  const linkedFrom = {};
  for (const u of indexes) {
    const r = await get(u);
    const rec = { url: u, kind: 'index', status: r.status, location: r.loc || null };
    if (r.body) { const h = decode(r.body, r.ct); rec.title = title(h); rec.links = links(h, u); for (const l of rec.links) (linkedFrom[l] ||= new Set()).add(u); }
    pages[u] = rec; process.stderr.write(`${r.status} ${u} ${(rec.links || []).length}\n`);
    await sleep(150);
  }
  const cand = Object.keys(linkedFrom).filter((l) => {
    const u = new URL(l); if (u.host !== 'www.asahi-kasei.co.jp') return false;
    if (!/^\/asahi\/(jp|en)\//.test(u.pathname)) return false;
    if (/\/shared\//.test(u.pathname) || /\.(css|js|ico|png|jpg|gif)$/i.test(u.pathname)) return false;
    return !pages[l];
  });
  fs.writeFileSync(OUT + '/linked-from.json', JSON.stringify(Object.fromEntries(Object.entries(linkedFrom).map(([k, v]) => [k, [...v]])), null, 1));
  fs.writeFileSync(OUT + '/index-pages.json', JSON.stringify(Object.values(pages), null, 1));
  const details = [];
  let i = 0;
  async function worker() {
    while (i < cand.length) {
      const u = cand[i++];
      const r = await get(u);
      const rec = { url: u, status: r.status, location: r.loc || null, ct: r.ct, len: r.len, from: [...linkedFrom[u]] };
      if (r.body) { const h = decode(r.body, r.ct); rec.title = title(h); rec.links = links(h, u).filter((l) => l.includes('asahi-kasei.co.jp/asahi/') && !l.includes('/shared/')); }
      details.push(rec);
      if (details.length % 200 === 0) process.stderr.write(`details ${details.length}/${cand.length}\n`);
      await sleep(50);
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  fs.writeFileSync(OUT + '/details.json', JSON.stringify(details, null, 1));
  process.stderr.write('done ' + details.length + '\n');
})();
