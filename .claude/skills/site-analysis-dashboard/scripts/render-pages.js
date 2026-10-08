#!/usr/bin/env node
/*
 * render-pages.js — resumable batch renderer + structural fingerprinter.
 *
 * For each URL in render-set.json:
 *   - loads locale-aware headless (CJK font picked up by fresh Chromium)
 *   - triggers lazy-load via scroll
 *   - extracts a STRUCTURAL FINGERPRINT: ordered list of top-level section
 *     "blocks" classified by a heuristic (hero, cards, columns, table, form,
 *     accordion, tabs, carousel, media, list, text, nav, breadcrumbs, iframe...)
 *   - records DOM signals for third-party integration detection (script srcs,
 *     global objects, iframes)
 *   - writes one JSON line per page to pages.jsonl (append; resume-safe)
 *
 * Screenshots are NOT taken here (separate capture pass on representatives),
 * except an optional --shot flag.
 *
 * Usage: node render-pages.js <catalogFolder> [--concurrency N] [--limit N]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { loadFetchMap, installAssetRoutes } = require('./fetch-map.js');


const CF = process.argv[2] || __dirname;
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CONCURRENCY = parseInt(arg('--concurrency', '4'), 10);
const LIMIT = parseInt(arg('--limit', '0'), 10);
const NAV_TIMEOUT = 45000;

const renderSet = JSON.parse(fs.readFileSync(path.join(CF, 'render-set.json'), 'utf8'));
let urls = renderSet.urls;
if (LIMIT > 0) urls = urls.slice(0, LIMIT);

const OUT = path.join(CF, 'pages.jsonl');
const FETCH = loadFetchMap(CF);
// resume: skip URLs already rendered
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).url); } catch (e) { /* ignore */ }
  }
}
const todo = urls.filter((u) => !done.has(u));
console.error(`Render set: ${urls.length}, already done: ${done.size}, todo: ${todo.length}`);

// --- in-page extractor (runs in browser context) ---
function extractInPage() {
  const norm = (s) => (s || '').toLowerCase();
  // classify a top-level element into a block type by heuristic
  function classify(el) {
    const cls = norm(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className);
    const id = norm(el.id);
    const tag = el.tagName.toLowerCase();
    const hay = cls + ' ' + id;
    const txt = (el.innerText || '').trim();
    const imgs = el.querySelectorAll('img,picture,video').length;
    const links = el.querySelectorAll('a').length;
    const tables = el.querySelectorAll('table').length;
    const forms = el.querySelectorAll('form,input,select,textarea').length;
    const iframes = el.querySelectorAll('iframe').length;
    const lis = el.querySelectorAll('li').length;
    const headings = el.querySelectorAll('h1,h2,h3,h4').length;
    const test = (re) => re.test(hay);
    if (tag === 'nav' || test(/breadcrumb|pankuz|topicpath/)) return test(/breadcrumb|pankuz|topicpath/) ? 'breadcrumbs' : 'nav';
    if (test(/hero|mv|mainvisual|main-visual|keyvisual|kv\b|jumbotron|billboard|cta-banner|hero-block/)) return 'hero';
    if (test(/carousel|slider|swiper|slick|bxslider/)) return 'carousel';
    if (test(/accordion|toggle|collaps|faq/)) return 'accordion';
    if (test(/\btab\b|tabs|tab-/)) return 'tabs';
    if (forms >= 2 || tag === 'form') return 'form';
    if (tables >= 1 || test(/table|spec|data-table/)) return 'table';
    if (iframes >= 1) return 'iframe-embed';
    if (test(/teaser|promo|feature-|featurette/) && imgs >= 1) return (imgs >= 2 || links >= 3) ? 'cards' : 'hero';
    if (test(/card|panel|tile|thumb|grid|gallery|list-|-list|news|release|index/) && (imgs >= 2 || links >= 4)) return 'cards';
    if (test(/\btitle\b|heading|headline/) && txt.length < 200 && imgs === 0) return 'text';
    if (test(/column|col-|two-col|three-col|feature|flex|row\b/) && imgs >= 1) return 'columns';
    if (lis >= 4 && links >= 4) return 'list';
    if (imgs >= 1 && txt.length < 40) return 'media';
    if (headings >= 1 && txt.length > 40) return 'text';
    if (txt.length > 0) return 'text';
    return 'other';
  }
  // pick the main content root, then descend through layout wrappers (AEM responsivegrid /
  // aem-Grid, containers, rows) to the real component level so the fingerprint reflects
  // actual sections rather than one page-wide wrapper.
  const main = document.querySelector('main, #main, .main, #contents, .contents, #content, .content, [role=main]') || document.body;
  const WRAP = /(^|\s|-)(root|responsivegrid|aem-grid|aem-gridcolumn|container|row|col|wrapper|section-wrapper|content-wrapper|page|main|inner|grid|layout|region|xf-content-height|experiencefragment)(\s|-|$)/i;
  const clsOf = (x) => ((x.className && x.className.baseVal !== undefined ? x.className.baseVal : x.className) || '').toString();
  const vis = (el) => Array.from(el.children).filter((c) => {
    if (c.nodeType !== 1) return false; const t = c.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') return false;
    const s = getComputedStyle(c); if (s.display === 'none' || s.visibility === 'hidden') return false;
    return c.offsetHeight > 8;
  });
  let root = main;
  for (let i = 0; i < 8; i++) {
    const k = vis(root);
    if (k.length === 1) { root = k[0]; continue; }
    if (k.length >= 2) {
      const real = k.filter((c) => !WRAP.test(clsOf(c)) || vis(c).length === 0);
      if (real.length >= 2) break;
      root = k.slice().sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      continue;
    }
    break;
  }
  let kids = vis(root);
  // one more expansion if a child is itself a grid wrapper
  const exp = [];
  for (const el of kids) { if (WRAP.test(clsOf(el)) && vis(el).length >= 2) vis(el).forEach((c) => exp.push(c)); else exp.push(el); }
  kids = exp;
  const blocks = kids.map(classify).filter((t) => t !== 'other');
  // integration signals
  const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
  const iframeSrcs = Array.from(document.querySelectorAll('iframe[src]')).map((s) => s.src);
  const globals = ['dataLayer', 'gtag', 'ga', '_gaq', 'google_tag_manager', 'fbq', '_hsq', 'Marketo',
    'utag', 'adobe', 's_gi', '__NEXT_DATA__', 'wp', 'Shopify', 'YT', 'Vimeo']
    .filter((g) => typeof window[g] !== 'undefined');
  return {
    title: document.title || '',
    lang: document.documentElement.lang || '',
    h1: (document.querySelector('h1') && document.querySelector('h1').innerText.trim().slice(0, 120)) || '',
    blockCount: blocks.length,
    blocks,
    signature: blocks.join('>'),
    scripts,
    iframeSrcs,
    globals,
    generator: (document.querySelector('meta[name=generator]') || {}).content || '',
    bodyClass: norm(document.body.className).slice(0, 200),
  };
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0; const step = 600;
      const t = setInterval(() => {
        window.scrollBy(0, step); total += step;
        if (total >= document.body.scrollHeight + 1200) { clearInterval(t); resolve(); }
      }, 90);
    });
    window.scrollTo(0, 0);
  }).catch(() => {});
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const stream = fs.createWriteStream(OUT, { flags: 'a' });
  let idx = 0; let ok = 0; let fail = 0;
  const queue = todo.slice();

  async function worker(wid) {
    const ctx = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 }, userAgent: process.env.SCOPE_UA || 'Mozilla/5.0 (compatible; site-scope/1.0; +layout-discovery)', ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    await installAssetRoutes(page, CF);
    while (queue.length) {
      const url = queue.shift();
      const n = ++idx;
      const rec = { url };
      try {
        await page.goto(FETCH(url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(600);
        await autoScroll(page);
        await page.waitForTimeout(300);
        const data = await page.evaluate(extractInPage);
        Object.assign(rec, data, { status: 'ok' });
        ok++;
      } catch (e) {
        rec.status = 'error'; rec.error = (e.message || String(e)).slice(0, 160);
        fail++;
      }
      stream.write(JSON.stringify(rec) + '\n');
      if (n % 20 === 0) console.error(`  [w${wid}] ${n}/${todo.length} done (ok=${ok} fail=${fail}) last=${url.slice(0, 70)}`);
    }
    await ctx.close();
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i));
  await Promise.all(workers);
  stream.end();
  await browser.close();
  console.error(`DONE rendering. ok=${ok} fail=${fail} total_processed=${idx}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
