// Pass 2: follow links from fetched pages until closure, restricted to the in-scope news prefixes (html + pdf/doc only).
const fs = require('fs');
const OUT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IN = /^https:\/\/www\.asahi-kasei\.co\.jp\/asahi\/(jp|en)\/(news\/20(0[6-9]|1[0-4])\/|csr\/news\/20(0[6-9]|1[0-4])\/)/;
const ASSET = /\.(jpe?g|gif|png|css|js|ico|swf|svg)$/i;
const norm = (u) => u.replace(/^http:\/\//, 'https://');
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (EDS migration scope crawl)' }, redirect: 'manual' });
      const ct = r.headers.get('content-type') || '';
      let body = null;
      if (ct.includes('html')) body = Buffer.from(await r.arrayBuffer()); else { try { await r.body?.cancel(); } catch {} }
      return { status: r.status, loc: r.headers.get('location'), ct, len: r.headers.get('content-length'), body };
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
    try { const u = new URL(raw, pageUrl); if (/^https?:$/.test(u.protocol)) { u.search = u.search; out.add(norm(u.href)); } } catch {}
  }
  return [...out];
}
const title = (h) => ((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
(async () => {
  const idx = JSON.parse(fs.readFileSync(OUT + '/index-pages.json'));
  const det = JSON.parse(fs.readFileSync(OUT + '/details.json'));
  const all = new Map();
  for (const p of idx) all.set(p.url, { ...p, pass: 0 });
  for (const d of det) all.set(d.url, { ...d, pass: 1 });
  const from = {};
  const queue = [];
  const consider = (src, l) => {
    if (!IN.test(l) || ASSET.test(new URL(l).pathname)) return;
    (from[l] ||= new Set()).add(src);
    if (!all.has(l) && !queue.includes(l)) queue.push(l);
  };
  for (const r of all.values()) for (const l of r.links || []) consider(r.url, norm(l));
  let pass = 2;
  while (queue.length) {
    const batch = queue.splice(0);
    process.stderr.write(`pass ${pass}: ${batch.length}\n`);
    let i = 0;
    const found = [];
    async function worker() {
      while (i < batch.length) {
        const u = batch[i++];
        const r = await get(u);
        const rec = { url: u, status: r.status, location: r.loc || null, ct: r.ct, len: r.len, pass, from: [...from[u]] };
        if (r.body) { const h = decode(r.body, r.ct); rec.title = title(h); rec.links = links(h, u).filter((l) => l.includes('asahi-kasei.co.jp/asahi/') && !l.includes('/shared/')); }
        all.set(u, rec); found.push(rec);
        await sleep(50);
      }
    }
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    for (const r of found) for (const l of r.links || []) consider(r.url, l);
    pass++;
  }
  // refresh 'from' on everything
  for (const [u, r] of all) if (from[u]) r.from = [...new Set([...(r.from || []), ...from[u]])];
  fs.writeFileSync(OUT + '/all.json', JSON.stringify([...all.values()], null, 1));
  process.stderr.write('total ' + all.size + '\n');
})();
