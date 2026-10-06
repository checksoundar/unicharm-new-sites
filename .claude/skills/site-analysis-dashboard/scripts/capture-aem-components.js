#!/usr/bin/env node
/*
 * capture-aem-components.js — AEM-Sites-aware block inventory via HTML tag-pattern analysis.
 *
 * For AEM Sites sources (pages built from aem-Grid / aem-GridColumn component wrappers) the
 * component wrapper's first class token IS the component resource name (teaser, iconcards,
 * leftrightcontent, ...). This stage walks the real component tree of every page in the
 * render set and, for every component instance, computes a normalised HTML TAG PATTERN:
 *
 *   - element tags only (text ignored), depth-limited
 *   - inline formatting tags dropped (span/strong/em/b/i/u/br/sup/sub/small/font)
 *   - runs of rich-text flow siblings (p/ul/ol/h1-h6/blockquote/hr) folded to `rte`
 *   - consecutive identical sibling sub-patterns folded to `x+` (3 cards == 4 cards)
 *   - nested AEM components replaced by `@name` (so a container's pattern is its layout,
 *     not its contents) and recorded as their own instances with a `parent`
 *   - slick/swiper clones dropped; role/aria and iframe host kept as semantic markers
 *
 * Per instance it also records the set of root-to-leaf tag paths (for Jaccard clustering
 * of near-identical patterns later), style-system tokens on the wrapper, modifier classes
 * on the component root, element counts and behaviour flags. Header/footer experience
 * fragments are recorded as `header` / `footer` chrome.
 *
 * Outputs (resume-safe by page URL):
 *   aem-components.jsonl  one record per component instance
 *   aem-pages.jsonl       one record per page (AEM template meta + top-level component sequence)
 *   blocks/<cmp>_<hash>.jpg  up to SHOTS_PER_PATTERN crops per distinct tag pattern
 *
 * Usage: node capture-aem-components.js <CF> [--concurrency N] [--shots-per-pattern N]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');


// ---------------- runs in the browser ----------------
function extractAem() {
  const LAYOUT = new Set(['container', 'responsivegrid', 'gridlayout', 'layoutcontainer', 'columncontrol', 'parsys']);
  const INLINE = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'br', 'sup', 'sub', 'small', 'font', 'wbr', 'abbr', 'mark', 's']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
  const FLOW = new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'rte']);
  const MAXD = 16;
  // component boundary: aem-Grid column, or a direct child of a simple-layout container (.cmp-container)
  const isCmp = (el) => el.nodeType === 1 && !el.classList.contains('aem-Grid') && !SKIP.has(el.tagName.toLowerCase())
    && (el.classList.contains('aem-GridColumn') || (el.parentElement && (el.parentElement.classList.contains('aem-Grid') || el.parentElement.classList.contains('cmp-container'))));
  const cmpName = (el) => (Array.from(el.classList).find((c) => !/^aem-/.test(c)) || el.tagName.toLowerCase());
  const styleTokens = (el) => Array.from(el.classList).filter((c) => !/^aem-/.test(c)).slice(1);
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  function iframeHost(f) { const s = f.getAttribute('src') || f.getAttribute('data-src') || ''; if (/youtube|youtu\.be/.test(s)) return 'youtube'; if (/vimeo/.test(s)) return 'vimeo'; if (/brightcove|players\.brightcove/.test(s)) return 'brightcove'; if (/google\.com\/maps/.test(s)) return 'gmaps'; return s ? 'ext' : 'blank'; }
  function token(n) {
    let t = n.tagName.toLowerCase();
    const role = n.getAttribute('role'); if (role && !/presentation|none/.test(role)) t += `[${role}]`;
    if (t === 'input') t += `[${n.getAttribute('type') || 'text'}]`;
    if (t === 'iframe') t += `[${iframeHost(n)}]`;
    if (n.hasAttribute('aria-expanded') && t !== 'a' ) t += '[exp]';
    return t;
  }
  // normalised tag pattern of a subtree + collection of root-to-leaf paths
  function pat(node, depth, root, trail, paths, nested, flat) {
    if (node !== root && !flat && isCmp(node)) { const nm = '@' + cmpName(node); nested.push(node); paths.add(trail + '/' + nm); return nm; }
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return null;
    if (node.classList && (node.classList.contains('slick-cloned') || node.classList.contains('swiper-slide-duplicate'))) return null;
    if (tag === 'svg') { paths.add(trail + '/svg'); return 'svg'; }
    const tk = token(node);
    const here = trail + '/' + tk;
    if (INLINE.has(tag)) { // transparent: lift its element children
      const out = []; for (const c of node.children) { const p = pat(c, depth, root, trail, paths, nested, flat); if (p) Array.isArray(p) ? out.push(...p) : out.push(p); }
      return out.length ? out : null;
    }
    const kids = [];
    if (depth < MAXD) for (const c of node.children) { const p = pat(c, depth + 1, root, here, paths, nested, flat); if (p) Array.isArray(p) ? kids.push(...p) : kids.push(p); }
    else if (node.children.length) { paths.add(here + '/…'); return tk + '(…)'; }
    if (!kids.length) { paths.add(here); return tk; }
    // fold rich-text flow runs, then identical consecutive siblings
    const f1 = [];
    for (const k of kids) { const isFlow = FLOW.has(k.replace(/\(.*$/, '').replace(/\[.*$/, '')); if (isFlow && f1.length && f1[f1.length - 1] === 'rte') continue; f1.push(isFlow ? 'rte' : k); }
    const f2 = [];
    for (const k of f1) { const last = f2[f2.length - 1]; if (last === k || last === k + '+') { f2[f2.length - 1] = k + '+'; continue; } f2.push(k); }
    // a bare wrapper <div> around a single child carries no structure: collapse the chain
    if (tk === 'div' && f2.length === 1 && /^div[(\[]?/.test(f2[0]) && !/\+$/.test(f2[0])) return f2[0];
    return tk + '(' + f2.join(',') + ')';
  }
  function counts(el) {
    const q = (s) => el.querySelectorAll(s).length;
    return { img: q('img,picture'), video: q('video'), iframe: q('iframe'), a: q('a[href]'), btn: q('button'), li: q('li'), h: q('h1,h2,h3,h4,h5,h6'), p: q('p'), form: q('form'), input: q('input:not([type=hidden]),select,textarea'), table: q('table') };
  }
  function flags(el) {
    return {
      slick: !!el.querySelector('.slick-slider,.slick-initialized') || el.classList.contains('slick-slider'),
      swiper: !!el.querySelector('.swiper,.swiper-container'),
      tablist: !!el.querySelector('[role=tablist]'),
      expanded: el.querySelectorAll('[aria-expanded],[data-toggle=collapse],[data-bs-toggle=collapse]').length,
      modal: !!el.querySelector('.modal,[role=dialog]'),
      dataAttrs: Array.from(new Set(Array.from(el.querySelectorAll('*')).slice(0, 400).flatMap((n) => Array.from(n.attributes).map((a) => a.name)).filter((n) => /^data-(?!sadblk)/.test(n)))).slice(0, 12),
      ajax: Array.from(el.querySelectorAll('[data-url],[data-path],[data-endpoint],[data-api],[data-json]')).length,
    };
  }
  function modifiers(el, name) {
    const first = Array.from(el.children).find((c) => !SKIP.has(c.tagName.toLowerCase()));
    const toks = [];
    for (const n of [first, first && first.firstElementChild].filter(Boolean)) {
      for (const c of n.classList) { if (/__/.test(c) && !/--|__v\d|__slick--/.test(c)) continue; if (/^(row|col|container|clearfix|cmp-[a-z]+$)/.test(c)) continue; toks.push(c); }
    }
    return Array.from(new Set(toks)).slice(0, 8);
  }
  const recs = []; const seq = [];
  let ord = 0;
  function visit(el, parent, depth, topLevel) {
    let name = cmpName(el);
    let chrome = null;
    if (name === 'experiencefragment') {
      const xf = el.querySelector('.cmp-experiencefragment');
      if (xf && /--header/.test(xf.className)) chrome = 'header'; else if (xf && /--footer/.test(xf.className)) chrome = 'footer';
    }
    const paths = new Set(); const nested = [];
    // chrome (header/footer XF) is fingerprinted flat — its inner components ARE its structure
    const pattern = pat(el, 0, el, '', paths, nested, !!chrome);
    const r = el.getBoundingClientRect();
    const isLayout = LAYOUT.has(name) || (name === 'experiencefragment' && !chrome);
    const kids = nested.filter((n) => n.getBoundingClientRect().height > 0);
    // a layout container whose visible child components sit on one row = columns layout
    let cols = 0; const rows = [];
    if (isLayout && kids.length >= 2) {
      const bs = kids.map((k) => k.getBoundingClientRect()).filter((b) => b.width > 80 && b.width < r.width * 0.8);
      for (const b of bs) { const row = rows.find((x) => Math.abs(x.top - b.top) < 40); if (row) row.n++; else rows.push({ top: b.top, n: 1 }); }
      cols = Math.max(0, ...rows.map((x) => x.n)); if (cols < 2) cols = 0;
    }
    const tagId = 'sadc-' + (ord++);
    el.setAttribute('data-sadblk', tagId);
    const h = el.querySelector('h1,h2,h3,h4');
    recs.push({
      tagId, cmp: chrome || name, rawName: name, chrome: !!chrome, layout: isLayout, cols, parent, depth, topLevel,
      style: styleTokens(el), mods: modifiers(el, name), pattern: typeof pattern === 'string' ? pattern : (pattern || []).join(','),
      paths: Array.from(paths).slice(0, 300), nested: nested.map(cmpName),
      box: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + window.scrollY) }, visible: visible(el) && r.height >= 30 && r.width >= 120,
      counts: counts(el), flags: flags(el), textLen: (el.innerText || '').trim().length,
      label: h ? h.innerText.trim().replace(/\s+/g, ' ').slice(0, 70) : '',
    });
    if (topLevel && !chrome && !isLayout) seq.push(name);
    if (chrome) return; // header/footer internals are chrome, not content blocks
    for (const n of nested) visit(n, chrome || name, depth + 1, topLevel && isLayout);
  }
  // top-level components = components with no component ancestor
  const all = Array.from(document.querySelectorAll('.aem-GridColumn, .aem-Grid > *, .cmp-container > *')).filter(isCmp);
  const hasCmpAncestor = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (isCmp(p)) return true; return false; };
  const tops = all.filter((el) => !hasCmpAncestor(el));
  for (const t of tops) visit(t, null, 0, true);
  const tmpl = (document.querySelector('meta[name=template]') || {}).content || '';
  return { recs, seq, template: tmpl, title: document.title, h1: (document.querySelector('h1') || {}).innerText || '', lang: document.documentElement.lang, aemGrid: all.length };
}

// hide fixed/sticky overlays (sticky header, JS cookie bar, chat widgets) so element crops are clean
// (header/footer chrome is shot after restoreOverlays())
function hideOverlays() {
  const CHROME = '.cmp-experiencefragment--header,.cmp-experiencefragment--footer';
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position;
    if (p !== 'fixed' && p !== 'sticky') continue;
    const inContent = el.closest('[data-sadblk]') && !el.closest(CHROME);
    if (inContent || el.querySelector('[data-sadblk]:not(' + CHROME.split(',').map((c) => c + ' *').join(',') + ')')) continue;
    el.style.setProperty('opacity', '0', 'important'); el.setAttribute('data-sadhidden', '1');
  }
  // the header XF re-appears on scroll (scroll-up reveal) — hide it outright for content crops
  for (const el of document.querySelectorAll('.cmp-experiencefragment--header')) { el.style.setProperty('opacity', '0', 'important'); el.setAttribute('data-sadhidden', '1'); }
}
function restoreOverlays() {
  for (const el of document.querySelectorAll('[data-sadhidden]')) { el.style.removeProperty('opacity'); el.removeAttribute('data-sadhidden'); }
  // keep the cookie bar / chat widgets hidden: anything fixed outside the header/footer XF
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position;
    if ((p === 'fixed' || p === 'sticky') && !el.closest('.cmp-experiencefragment--header,.cmp-experiencefragment--footer,[data-sadblk]')) el.style.setProperty('opacity', '0', 'important');
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((res) => { let y = 0; const t = setInterval(() => { window.scrollBy(0, 700); y += 700; if (y >= document.body.scrollHeight + 800) { clearInterval(t); res(); } }, 80); });
    window.scrollTo(0, 0);
  }).catch(() => {});
}

async function main() {
  const CF = process.argv[2] || __dirname;
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
  const CONCURRENCY = parseInt(arg('--concurrency', '4'), 10);
  const SHOTS = parseInt(arg('--shots-per-pattern', '2'), 10);
  const PAGE_DELAY = parseInt(process.env.SCOPE_DELAY || '0', 10);
  const urls = JSON.parse(fs.readFileSync(path.join(CF, 'render-set.json'), 'utf8')).urls;
  const BLOCKS_DIR = path.join(CF, 'blocks');
  fs.mkdirSync(BLOCKS_DIR, { recursive: true });
  const OUT_C = path.join(CF, 'aem-components.jsonl');
  const OUT_P = path.join(CF, 'aem-pages.jsonl');
  const done = new Set();
  const shotCount = {};
  if (fs.existsSync(OUT_P)) for (const l of fs.readFileSync(OUT_P, 'utf8').split('\n')) { try { const r = JSON.parse(l); if (r.status === 'ok') done.add(r.url); } catch (e) { /* skip */ } }
  if (fs.existsSync(OUT_C)) for (const l of fs.readFileSync(OUT_C, 'utf8').split('\n')) { try { const r = JSON.parse(l); if (r.file) shotCount[r.cmp + ':' + r.hash] = (shotCount[r.cmp + ':' + r.hash] || 0) + 1; } catch (e) { /* skip */ } }
  const todo = urls.filter((u) => !done.has(u));
  console.error(`Render set ${urls.length}, done ${done.size}, todo ${todo.length}`);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const cs = fs.createWriteStream(OUT_C, { flags: 'a' }); const ps = fs.createWriteStream(OUT_P, { flags: 'a' });
  const queue = todo.slice(); let n = 0; let shots = 0;
  async function worker(wid) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: process.env.SCOPE_UA || undefined, ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); page.setDefaultTimeout(45000);
    while (queue.length) {
      const url = queue.shift(); const i = ++n;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800); await autoScroll(page); await page.waitForTimeout(600);
        // dismiss cookie banners that would overlay crops
        await page.evaluate(() => { document.querySelectorAll('#onetrust-consent-sdk,.cookie-banner,#CybotCookiebotDialog').forEach((e) => e.remove()); }).catch(() => {});
        const data = await page.evaluate(extractAem);
        await page.evaluate(hideOverlays).catch(() => {});
        data.recs.sort((x, y) => (x.chrome ? 1 : 0) - (y.chrome ? 1 : 0)); // content first, chrome last
        let restored = false;
        for (const r of data.recs) {
          if (r.chrome && !restored) { await page.evaluate(restoreOverlays).catch(() => {}); restored = true; }
          r.hash = crypto.createHash('md5').update(r.cmp + '|' + r.pattern).digest('hex').slice(0, 10);
          const k = r.cmp + ':' + r.hash;
          const rec = { pageUrl: url, ...r };
          if (r.visible && !r.layout && (shotCount[k] || 0) < SHOTS && r.box.h < 6000) {
            shotCount[k] = (shotCount[k] || 0) + 1;
            const file = `${r.cmp.replace(/[^a-z0-9-]/gi, '')}_${r.hash}_${shotCount[k]}.jpg`;
            try {
              if (!r.chrome) await page.evaluate(hideOverlays).catch(() => {});
              await page.locator(`[data-sadblk="${r.tagId}"]`).first().screenshot({ path: path.join(BLOCKS_DIR, file), type: 'jpeg', quality: 72, timeout: 15000 });
              rec.file = file; shots++;
            } catch (e) { shotCount[k] -= 1; rec.shotErr = (e.message || '').split('\n')[0].slice(0, 80); }
          } else if (r.visible && r.layout && r.cols >= 2 && (shotCount[k] || 0) < SHOTS) {
            shotCount[k] = (shotCount[k] || 0) + 1;
            const file = `layout_${r.hash}_${shotCount[k]}.jpg`;
            try { await page.locator(`[data-sadblk="${r.tagId}"]`).first().screenshot({ path: path.join(BLOCKS_DIR, file), type: 'jpeg', quality: 72, timeout: 15000 }); rec.file = file; shots++; } catch (e) { shotCount[k] -= 1; }
          }
          delete rec.tagId;
          cs.write(JSON.stringify(rec) + '\n');
        }
        ps.write(JSON.stringify({ url, status: 'ok', template: data.template, seq: data.seq, title: data.title, h1: data.h1.trim().slice(0, 120), lang: data.lang, components: data.recs.length, aemGrid: data.aemGrid }) + '\n');
      } catch (e) {
        ps.write(JSON.stringify({ url, status: 'error', error: (e.message || '').slice(0, 160) }) + '\n');
        await page.waitForTimeout(3000);
      }
      if (PAGE_DELAY) await page.waitForTimeout(PAGE_DELAY);
      if (i % 20 === 0) console.error(`  [w${wid}] ${i}/${todo.length} pages, shots=${shots}`);
    }
    await ctx.close();
  }
  const ws = []; for (let i = 0; i < CONCURRENCY; i++) ws.push(worker(i));
  await Promise.all(ws); cs.end(); ps.end(); await browser.close();
  console.error(`DONE pages=${n} shots=${shots}`);
}

module.exports = { extractAem, hideOverlays, restoreOverlays, autoScroll };
if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
