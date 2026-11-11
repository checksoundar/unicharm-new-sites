// Inventory of element/class patterns inside #column-article for a stratified sample of in-scope pages.
const fs = require('fs');
const OUT = process.argv[2];
const S = JSON.parse(fs.readFileSync(process.argv[3]));
const pick = {};
for (const p of S.pages) {
  const k = `${p.locale}|${p.type}|${p.year < 2011 ? '2006-10' : '2011-14'}`;
  (pick[k] ||= []);
  if (pick[k].length < 8 && Math.random() < 0.25) pick[k].push(p.url);
}
function decode(buf, ct) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const m = buf.toString('latin1').match(/charset=["']?([\w-]+)/i); cs = m && m[1]; }
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}
(async () => {
  const res = {};
  for (const [k, urls] of Object.entries(pick)) {
    const cls = {}; const tags = {};
    for (const u of urls) {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const h = decode(Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || '');
      const start = h.indexOf('id="column-article"');
      const end = h.indexOf('id="column-aside"');
      const body = h.slice(start, end > start ? end : undefined);
      const seen = new Set();
      for (const m of body.matchAll(/<(\w+)([^>]*)>/g)) {
        const t = m[1].toLowerCase(); const c = (m[2].match(/class=["']([^"']+)["']/) || [])[1];
        if (['br', 'span', 'a', 'strong', 'b', 'li', 'td', 'tr', 'th', 'tbody', 'p'].includes(t) && !c) continue;
        const key = c ? `${t}.${c.trim().split(/\s+/).join('.')}` : t;
        if (!seen.has(key)) { seen.add(key); cls[key] = (cls[key] || 0) + 1; }
      }
    }
    res[k] = { sample: urls.length, urls, patterns: Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 40) };
  }
  fs.writeFileSync(OUT + '/inner-patterns.json', JSON.stringify(res, null, 1));
  for (const [k, v] of Object.entries(res)) console.log(`\n== ${k} (n=${v.sample})\n` + v.patterns.map(([c, n]) => `${n} ${c}`).join(' | '));
})();
