// Ordered list of links inside the news table (table.tbl-news-01) of each JP CSR tab, FY2014 -> FY2006 is NOT assumed; we keep FY2006 -> FY2014 order and also print per-tab order.
const fs = require('fs');
const OUT = process.argv[2];
(async () => {
  const rows = [];
  for (let y = 2006; y <= 2014; y++) {
    const u = `https://www.asahi-kasei.co.jp/asahi/jp/news/${y}/csr.html`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const h = new TextDecoder('utf-8').decode(Buffer.from(await r.arrayBuffer()));
    const tables = [...h.matchAll(/<table[^>]*class="[^"]*tbl-news-01[^"]*"[\s\S]*?<\/table>/gi)].map((m) => m[0]).join('\n');
    for (const m of tables.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const tr = m[0];
      const links = [...tr.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((x) => new URL(x[1], u).href.replace(/^http:/, 'https:'));
      const text = tr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      for (const l of links) rows.push({ fy: y, tab: u, url: l, text: text.slice(0, 80) });
    }
  }
  fs.writeFileSync(OUT + '/csr-tab-links.json', JSON.stringify(rows, null, 1));
  const uniq = [...new Set(rows.map((r) => r.url))];
  console.log('links', rows.length, 'unique', uniq.length);
  const by = {};
  for (const l of uniq) { const k = l.replace(/^https:\/\/www\.asahi-kasei\.co\.jp/, '').replace(/[^/]+$/, '*'); by[k] = (by[k] || 0) + 1; }
  console.log(by);
})();
