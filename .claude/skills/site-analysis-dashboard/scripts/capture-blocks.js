#!/usr/bin/env node
/*
 * capture-blocks.js — per-block instance capture across the render set.
 *
 * For each page: find meaningful block-level elements (walk into section wrappers),
 * classify each, compute a structural signature (for later variant dedup), and
 * crop-screenshot each visible block. Appends one JSON record per block to
 * blocks.jsonl (resume-safe by page URL). Screenshots -> blocks/<hash>.jpg.
 *
 * Usage: node capture-blocks.js <CF> [--concurrency N] [--limit N] [--max-blocks-per-page N]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const CF = process.argv[2] || __dirname;
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CONCURRENCY = parseInt(arg('--concurrency', '4'), 10);
const LIMIT = parseInt(arg('--limit', '0'), 10);
const MAXB = parseInt(arg('--max-blocks-per-page', '20'), 10);
const PAGE_DELAY = parseInt(process.env.SCOPE_DELAY || arg('--delay', '0'), 10); // ms between pages (WAF politeness)

const renderSet = JSON.parse(fs.readFileSync(path.join(CF, 'render-set.json'), 'utf8'));
let urls = renderSet.urls;
if (LIMIT > 0) urls = urls.slice(0, LIMIT);

const BLOCKS_DIR = path.join(CF, 'blocks');
fs.mkdirSync(BLOCKS_DIR, { recursive: true });
const OUT = path.join(CF, 'blocks.jsonl');
const donePages = new Set();
if (fs.existsSync(OUT)) {
  for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { if (!l.trim()) continue; try { donePages.add(JSON.parse(l).pageUrl); } catch (e) {} }
}
const todo = urls.filter((u) => !donePages.has(u));
console.error(`Render set ${urls.length}, pages already captured ${donePages.size}, todo ${todo.length}`);

// runs in browser: return array of {type,signature,box,textLen,label}
function findBlocks(MAXB) {
  const norm = (s) => (s || '').toLowerCase();
  function cls(el) {
    const c = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    return norm(typeof c === 'string' ? c : '') + ' ' + norm(el.id || '');
  }
  // --- class-agnostic structural helpers (for hashed/non-semantic markup, e.g. Next.js) ---
  function realKids(node) {
    return Array.from(node.children).filter((c) => {
      if (c.nodeType !== 1) return false;
      const tg = c.tagName; return !(tg === 'SCRIPT' || tg === 'STYLE' || tg === 'NOSCRIPT' || tg === 'TEMPLATE');
    });
  }
  // horizontal scroller with several slides = carousel, regardless of class names
  function hScroller(el) {
    const cand = [el].concat(Array.from(el.children));
    for (const n of cand) {
      try {
        const cs = getComputedStyle(n);
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth * 1.25 && realKids(n).length >= 3) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }
  // 2-6 similar-width children sitting on the same row = a column/card grid
  function equalRow(el) {
    const res = { n: 0, imgShare: 0 };
    const kids = realKids(el);
    if (kids.length < 2 || kids.length > 6) return res;
    const rects = kids.map((k) => ({ k, r: k.getBoundingClientRect() })).filter((o) => o.r.width > 80 && o.r.height > 40);
    if (rects.length < 2) return res;
    const top0 = rects[0].r.top;
    const sameRow = rects.filter((o) => Math.abs(o.r.top - top0) < 30);
    if (sameRow.length < 2) return res;
    const ws = sameRow.map((o) => o.r.width);
    if (Math.max.apply(null, ws) / Math.min.apply(null, ws) > 1.9) return res;
    const withImg = sameRow.filter((o) => o.k.querySelector('img,picture,video')).length;
    res.n = sameRow.length; res.imgShare = withImg / sameRow.length;
    return res;
  }
  function classify(el) {
    const hay = cls(el); const tag = el.tagName.toLowerCase();
    const imgs = el.querySelectorAll('img,picture,video').length;
    const links = el.querySelectorAll('a').length;
    const tables = el.querySelectorAll('table').length;
    const forms = el.querySelectorAll('form,input,select,textarea').length;
    const iframes = el.querySelectorAll('iframe').length;
    const lis = el.querySelectorAll('li').length;
    const heads = el.querySelectorAll('h1,h2,h3,h4').length;
    const paras = el.querySelectorAll('p').length;
    const childEls = Array.from(el.children).filter((c) => c.nodeType === 1).length;
    const txt = (el.innerText || '').trim();
    const t = (re) => re.test(hay);
    // Tier 1: class/id keyword signals
    if (t(/breadcrumb|pankuz|topicpath/)) return 'breadcrumbs';
    if (tag === 'nav' || t(/global-?nav|gnav|mainnav|header|drawer/)) return 'nav';
    if (t(/hero|mv\b|mainvisual|main-visual|keyvisual|kv\b|billboard|jumbotron|cta-banner|hero-block/)) return 'hero';
    if (t(/carousel|slider|swiper|slick|bxslider/)) return 'carousel';
    if (t(/accordion|toggle|collaps|faq/)) return 'accordion';
    if (t(/\btab\b|tabs|tab-/)) return 'tabs';
    // Tier 1b: structural / ARIA / behaviour signals (class-agnostic — for hashed markup, e.g. Next.js)
    // video: a <video> tag, or an embed pointing at a known video host
    const vid = el.querySelector('video');
    const vidIframe = Array.from(el.querySelectorAll('iframe')).some((f) => /youtube|youtu\.be|youtube-nocookie|vimeo|wistia|brightcove|vidyard/i.test(f.getAttribute('src') || f.getAttribute('data-src') || ''));
    if (vid || vidIframe) return 'video';
    // tabs: ARIA tablist with 2+ tabs
    if ((el.querySelector('[role=tablist]') && el.querySelectorAll('[role=tab]').length >= 2) || el.querySelectorAll('[aria-selected]').length >= 2) return 'tabs';
    // accordion: 2+ ARIA disclosure buttons / details elements
    if (el.querySelectorAll('details').length >= 2 || el.querySelectorAll('button[aria-expanded],[role=button][aria-expanded]').length >= 2) return 'accordion';
    // carousel: horizontal scroller with 3+ slides, or roles/attrs used by headless carousels
    if (hScroller(el) || el.querySelector('[aria-roledescription="carousel"],[data-carousel],[data-slide],[data-glide],[data-embla]')) return 'carousel';
    // Tier 2: semantic HTML
    if (forms >= 2 || tag === 'form') return 'form';
    if (iframes >= 1) return 'iframe-embed';
    if (tables >= 1) return 'table';
    // Tier 2b: equal-width row of siblings = columns (mostly text) or cards (mostly image tiles)
    const row = equalRow(el);
    if (row.n >= 2) {
      if (row.imgShare >= 0.5 && (row.n >= 3 || imgs >= row.n)) return 'cards';
      if (row.n >= 2) return 'columns';
    }
    // Tier 3: keyword + content heuristics (teaser/promo/feature are common component names)
    if (t(/teaser|promo|feature-|featurette/) && imgs >= 1) return (imgs >= 2 || links >= 3) ? 'cards' : 'hero';
    if ((t(/card|panel|tile|thumb|grid|gallery|list-|-list|news|release|link/) && (imgs >= 2 || links >= 4))) return 'cards';
    if (t(/\btitle\b|heading|headline/) && txt.length < 200 && imgs === 0) return 'text';
    if (t(/column|col-|two-col|three-col|feature|row\b|flex/) && imgs >= 1) return 'columns';
    if (t(/list|index|nav/) && lis >= 5 && links >= 5) return 'list';
    // Tier 4: media vs prose
    if (imgs >= 1 && txt.length < 60) return 'media';
    // plain prose: heading + paragraphs, little composite structure, no signal
    const isProse = (heads >= 0 && paras >= 1 && imgs <= 1 && links < 4) || (txt.length > 30 && childEls <= 2 && imgs === 0);
    if (isProse) return 'text';
    // Tier 5: composite structure but no recognised signal -> unknown / custom
    if (childEls >= 2 || imgs >= 2 || links >= 4 || lis >= 4) return 'unknown';
    if (txt.length > 30) return 'text';
    return 'other';
  }
  function sig(el) {
    // shallow structural signature: tag + child tag histogram + feature flags
    const kids = {}; Array.from(el.children).forEach((c) => { const t = c.tagName.toLowerCase(); kids[t] = (kids[t] || 0) + 1; });
    const feat = [
      el.querySelector('img,picture,video') ? 'img' : '',
      el.querySelector('table') ? 'tbl' : '',
      el.querySelector('ul,ol') ? 'lst' : '',
      el.querySelector('form,input') ? 'frm' : '',
      el.querySelector('iframe') ? 'ifr' : '',
      el.querySelector('h1,h2,h3') ? 'hd' : '',
      'a' + Math.min(9, el.querySelectorAll('a').length),
      'i' + Math.min(9, el.querySelectorAll('img').length),
    ].filter(Boolean).join(',');
    const kh = Object.entries(kids).sort().map(([k, v]) => `${k}${v}`).join('.');
    return `${el.tagName.toLowerCase()}|${kh}|${feat}`;
  }
  // Try selectors in PRIORITY order (querySelector with a comma-list returns the first
  // match in document order, which can wrongly grab a `.main`/`.content` HEADER wrapper
  // that precedes the real <main> — so resolve semantic landmarks first).
  let main = null;
  for (const sel of ['main', '[role=main]', '#main', '#content', '#contents', '.main-content', '.content-main', '.main', '.content', '.contents']) {
    const cands = Array.from(document.querySelectorAll(sel));
    // pick the tallest match for this selector (skips small header/utility wrappers)
    const best = cands.filter((e) => e.getBoundingClientRect().height > 300)
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    if (best) { main = best; break; }
  }
  main = main || document.body;
  // Layout wrappers that hold components but are not themselves a block (AEM, Bootstrap, etc.)
  const WRAP = /(^|\s|-)(root|responsivegrid|aem-grid|aem-gridcolumn|container|row|col|wrapper|section-wrapper|content-wrapper|page|main|inner|grid|layout|region|xf-content-height|experiencefragment)(\s|-|$)/i;
  const kidsOf = (el) => Array.from(el.children).filter((c) => {
    if (c.nodeType !== 1) return false;
    const t = c.tagName; if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') return false;
    const s = getComputedStyle(c); if (s.display === 'none' || s.visibility === 'hidden') return false;
    return true;
  });
  // Descend through single-child and pure-wrapper layers until we hit a level with
  // several real components (or can't usefully descend further).
  function findComponentLevel(root, depth) {
    let el = root;
    for (let i = 0; i < 8; i++) {
      const kids = kidsOf(el);
      if (kids.length === 0) return [el];
      if (kids.length === 1) { el = kids[0]; continue; }               // thin wrapper → descend
      // multiple children: if they're mostly layout wrappers with one dominant tall child, descend into it
      const cls = (x) => ((x.className && x.className.baseVal !== undefined ? x.className.baseVal : x.className) || '').toString();
      const realKids = kids.filter((k) => !WRAP.test(cls(k)) || kidsOf(k).length === 0);
      if (realKids.length >= 2) return kids;                            // genuine component grid
      // else the multiple kids are all wrappers — descend into the tallest
      el = kids.slice().sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    }
    return kidsOf(el).length ? kidsOf(el) : [el];
  }
  let expanded = findComponentLevel(main, 0);
  // If a returned component is itself a grid wrapper, expand it one more level (AEM aem-Grid nesting)
  const expanded2 = [];
  for (const el of expanded) {
    const cls = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '').toString();
    const kids = kidsOf(el);
    if (WRAP.test(cls) && kids.length >= 2) kids.forEach((k) => expanded2.push(k));
    else expanded2.push(el);
  }
  expanded = expanded2;
  const out = [];
  for (const el of expanded) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 40 || r.width < 200) continue; // skip tiny
    if (r.height > 9000) continue;                // skip whole-page wrappers
    const type = classify(el);
    if (type === 'other' || type === 'nav') continue;
    // tag the element so the capture loop can grab this exact handle (robust to reflow)
    const tagId = 'sadblk-' + out.length;
    el.setAttribute('data-sadblk', tagId);
    out.push({ type, signature: sig(el), tagId, textLen: (el.innerText || '').trim().length, label: (el.querySelector('h1,h2,h3') || {}).innerText ? el.querySelector('h1,h2,h3').innerText.trim().slice(0, 60) : '' });
    if (out.length >= MAXB) break;
  }
  return out;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((res) => { let y = 0; const s = 700; const t = setInterval(() => { window.scrollBy(0, s); y += s; if (y >= document.body.scrollHeight + 1000) { clearInterval(t); res(); } }, 70); });
    window.scrollTo(0, 0);
  }).catch(() => {});
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const stream = fs.createWriteStream(OUT, { flags: 'a' });
  const queue = todo.slice(); let pi = 0; let blockN = 0;

  async function worker(wid) {
    const ctx = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, userAgent: process.env.SCOPE_UA || 'Mozilla/5.0 (compatible; site-scope/1.0; +layout-discovery)', ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); page.setDefaultTimeout(45000);
    while (queue.length) {
      const url = queue.shift(); const n = ++pi;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(500); await autoScroll(page); await page.waitForTimeout(300);
        const blocks = await page.evaluate(findBlocks, MAXB);
        let ord = 0;
        for (const b of blocks) {
          ord++;
          const hash = crypto.createHash('md5').update(url + '#' + ord).digest('hex').slice(0, 12);
          const file = `${b.type}_${hash}.jpg`;
          const rec = { pageUrl: url, ord, type: b.type, signature: b.signature, textLen: b.textLen, label: b.label, file };
          try {
            // screenshot the exact element handle: Playwright scrolls it into view and clips
            // to its box, which is robust to lazy-load reflow (no manual coordinate math).
            const loc = page.locator(`[data-sadblk="${b.tagId}"]`).first();
            await loc.screenshot({ path: path.join(BLOCKS_DIR, file), type: 'jpeg', quality: 72, timeout: 15000 });
            rec.captured = true; blockN++;
          } catch (e) { rec.captured = false; rec.err = (e.message || '').split('\n')[0].slice(0, 80); }
          stream.write(JSON.stringify(rec) + '\n');
        }
        if (PAGE_DELAY > 0) await page.waitForTimeout(PAGE_DELAY);
      } catch (e) {
        stream.write(JSON.stringify({ pageUrl: url, status: 'error', error: (e.message || '').slice(0, 120) }) + '\n');
        // WAF/throttle backoff: on failure wait progressively longer before the next page
        await page.waitForTimeout(Math.max(PAGE_DELAY, 3000));
      }
      if (n % 20 === 0) console.error(`  [w${wid}] ${n}/${todo.length} pages (blocks captured=${blockN}) ${url.slice(0, 60)}`);
    }
    await ctx.close();
  }
  const ws = []; for (let i = 0; i < CONCURRENCY; i++) ws.push(worker(i));
  await Promise.all(ws); stream.end(); await browser.close();
  console.error(`DONE. pages=${pi} blocks=${blockN}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
