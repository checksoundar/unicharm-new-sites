// Structural fingerprint of a sample of in-scope pages (first 2 per locale/year/folder) to see how many layouts exist.
const fs = require('fs');
const OUT = process.argv[2];
const A = JSON.parse(fs.readFileSync(OUT + '/all.json'));
const pick = {};
for (const r of A) {
  if (r.status !== 200 || !(r.ct || '').includes('html')) continue;
  const m = r.url.match(/\/asahi\/(jp|en)\/(csr\/news|news)\/(\d{4})\/([^/]*)$/);
  if (!m) continue;
  const kind = /^(|index\.html|press\.html|ir\.html|csr\.html)$/.test(m[4]) ? 'index' : 'detail';
  const k = `${m[1]}|${m[2]}|${m[3]}|${kind}`;
  (pick[k] ||= []).length < 2 && pick[k].push(r.url);
}
function decode(buf, ct) {
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const m = buf.toString('latin1').match(/charset=["']?([\w-]+)/i); cs = m && m[1]; }
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}
(async () => {
  const rows = [];
  for (const [k, urls] of Object.entries(pick)) {
    for (const u of urls) {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = r.headers.get('content-type') || '';
      const h = decode(Buffer.from(await r.arrayBuffer()), ct);
      const ids = [...h.matchAll(/<div[^>]+id=["']([^"']+)["']/gi)].map((x) => x[1]).slice(0, 12).join(',');
      const charset = (ct.match(/charset=([\w-]+)/i) || [, (h.match(/charset=["']?([\w-]+)/i) || [])[1]])[1];
      const doctype = (h.match(/<!DOCTYPE[^>]*>/i) || [''])[0].slice(0, 60);
      rows.push({ k, u, charset, doctype, ids, tables: (h.match(/<table/gi) || []).length, imgs: (h.match(/<img/gi) || []).length });
    }
  }
  fs.writeFileSync(OUT + '/fingerprint.json', JSON.stringify(rows, null, 1));
  const g = {};
  for (const r of rows) { const f = `${r.k.split('|')[3]} :: ${r.charset} :: ${r.ids}`; (g[f] ||= []).push(r.k); }
  for (const [f, ks] of Object.entries(g)) console.log(ks.length, f, '\n    e.g.', [...new Set(ks)].slice(0, 6).join('  '));
})();
