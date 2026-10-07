#!/usr/bin/env node
/*
 * consolidate-aem-components.js — turn aem-components.jsonl (tag-pattern capture) into a
 * classified block inventory, and back-fill the generic pipeline artifacts.
 *
 * 1. Per AEM component: group instances by exact normalised tag pattern (hash), then merge
 *    near-identical patterns by Jaccard similarity of their root-to-leaf tag-path sets
 *    (>= JACCARD, default 0.8) into STRUCTURAL VARIANTS — so an author omitting one optional
 *    field does not create a new variant, but a different DOM shape does.
 * 2. Classify every component -> EDS target + category using <CF>/block-mapping.json
 *    (site knowledge, evidence-reviewed) with a tag-pattern heuristic fallback:
 *      boilerplate      maps to a standard EDS / Block Collection block (hero, cards, columns,
 *                       carousel, accordion, tabs, video, embed, table, quote, fragment, form…)
 *      custom           needs a bespoke EDS block (data-driven listing, bespoke interaction,
 *                       or a layout with no standard equivalent)
 *      default-content  authored as EDS default content (text, title, image, button)
 *      section          layout container -> EDS section (+ section metadata style)
 *      chrome           header / footer (EDS header/footer fragments)
 * 3. Writes:
 *      aem-block-inventory.json   full classified inventory (components -> variants -> patterns)
 *      block-catalog.json         dashboard-compatible variant catalog (base = gallery key)
 *      blocks.jsonl               dashboard-compatible instance records
 *      pages.jsonl                rewritten: signature/blocks from the AEM component sequence
 *      layouts.json               AEM page-template families (property · template)
 *
 * Usage: node consolidate-aem-components.js <CF> [--jaccard 0.8]
 */
const fs = require('fs');
const path = require('path');

const CF = process.argv[2] || '.';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const JACCARD = parseFloat(arg('--jaccard', '0.8'));
const CFG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8'));
const ORIGIN = CFG.siteOrigin;
const rdl = (f) => fs.readFileSync(path.join(CF, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// de-duplicate: a capture interrupted mid-page and resumed re-records that page's components
const comps = (() => {
  const seen = new Set();
  return rdl('aem-components.jsonl').filter((c) => {
    const k = [c.pageUrl, c.cmp, c.hash, c.depth, c.parent, c.box && c.box.top, c.box && c.box.h].join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
})();
const aemPages = rdl('aem-pages.jsonl').filter((p) => p.status === 'ok');
// mapping = optional shared library (config.sharedMapping, e.g. one per brand family) overlaid by
// the site's own <CF>/block-mapping.json; keys starting with "_" are comments
const readMap = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const MAP = Object.fromEntries(Object.entries({ ...readMap(CFG.sharedMapping), ...readMap(path.join(CF, 'block-mapping.json')) }).filter(([k]) => !k.startsWith('_')));
const PROPS = CFG.properties || null; // optional [{key,label,prefix}]
const propOf = (u) => {
  const p = u.replace(ORIGIN, '');
  if (PROPS) { const m = PROPS.find((x) => p.startsWith(x.prefix)); return m ? m.key : 'other'; }
  return p.split('/')[1] || 'root';
};

// ---------- heuristic fallback classification from the tag pattern ----------
function heuristic(cmp, insts) {
  const any = (fn) => insts.some(fn);
  const pat = insts.map((i) => i.pattern).join(' ');
  if (insts[0].chrome) return { eds: cmp, category: 'chrome', rationale: 'Experience-fragment header/footer → EDS header/footer fragment.' };
  if (insts[0].layout) return { eds: 'section', category: 'section', rationale: 'Layout container → EDS section; container style → section metadata.' };
  if (any((i) => i.flags.tablist)) return { eds: 'tabs', category: 'boilerplate', rationale: 'role=tablist present.' };
  if (any((i) => i.flags.slick || i.flags.swiper) || /\[tabpanel\]/.test(pat)) return { eds: 'carousel', category: 'boilerplate', rationale: 'Slider runtime / tabpanel slides.' };
  if (/\[exp\]/.test(pat)) return { eds: 'accordion', category: 'boilerplate', rationale: 'aria-expanded disclosure.' };
  if (any((i) => i.counts.form || i.counts.input >= 2)) return { eds: 'form', category: 'custom', rationale: 'Form posting to a backend.' };
  if (/iframe\[(youtube|vimeo|brightcove)\]/.test(pat) || any((i) => i.counts.video)) return { eds: 'video', category: 'boilerplate', rationale: 'Video element / player iframe.' };
  if (/iframe/.test(pat)) return { eds: 'embed', category: 'boilerplate', rationale: 'iframe embed.' };
  if (/table\(/.test(pat)) return { eds: 'table', category: 'boilerplate', rationale: 'table element.' };
  if (/\)\+/.test(pat) && any((i) => i.counts.img >= 2)) return { eds: 'cards', category: 'boilerplate', rationale: 'Repeated image items.' };
  if (/^div\(rte\)$|^div$/.test(insts[0].pattern)) return { eds: 'default-content', category: 'default-content', rationale: 'Rich text only.' };
  return { eds: cmp, category: 'custom', rationale: 'No standard block signal in tag pattern.' };
}

// ---------- group by component -> exact pattern -> jaccard variants ----------
const byCmp = {};
for (const c of comps) (byCmp[c.cmp] = byCmp[c.cmp] || []).push(c);
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const inventory = [];
for (const [cmp, insts] of Object.entries(byCmp)) {
  const byHash = {};
  for (const i of insts) {
    const h = byHash[i.hash] || (byHash[i.hash] = { hash: i.hash, pattern: i.pattern, insts: [], paths: new Set(), files: [] });
    h.insts.push(i); i.paths.forEach((p) => h.paths.add(p)); if (i.file) h.files.push({ file: i.file, url: i.pageUrl, h: i.box.h, textLen: i.textLen });
  }
  const hashes = Object.values(byHash).sort((a, b) => b.insts.length - a.insts.length);
  const variants = [];
  for (const h of hashes) {
    let best = null; let bs = 0;
    for (const v of variants) { const s = jac(h.paths, v.paths); if (s > bs) { bs = s; best = v; } }
    if (best && bs >= JACCARD) { best.hashes.push(h); h.paths.forEach((p) => best.paths.add(p)); best.sim.push(+bs.toFixed(2)); }
    else variants.push({ hashes: [h], paths: new Set(h.paths), sim: [] });
  }
  const mapping = MAP[cmp] || heuristic(cmp, insts);
  const vOut = variants.map((v, vi) => {
    const all = v.hashes.flatMap((h) => h.insts);
    const pages = new Set(all.map((i) => i.pageUrl));
    const files = v.hashes.flatMap((h) => h.files).filter((f) => f.h >= 40);
    // representative screenshot: the most "complete" crop (most text) from the dominant pattern
    const rep = files.sort((a, b) => b.textLen - a.textLen)[0] || null;
    const mods = {}; const style = {};
    all.forEach((i) => { i.mods.forEach((m) => { mods[m] = (mods[m] || 0) + 1; }); i.style.forEach((s) => { style[s] = (style[s] || 0) + 1; }); });
    const props = {}; all.forEach((i) => { const p = propOf(i.pageUrl); props[p] = (props[p] || 0) + 1; });
    const labels = {}; all.forEach((i) => { if (i.label) labels[i.label] = (labels[i.label] || 0) + 1; });
    const med = (k) => { const a = all.map((i) => i.counts[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    // per-variant override: variantRules [{ pattern|style|mod: regex, eds, category, note }] (first match wins)
    const styleStr = Object.keys(style).join(' '); const modStr = Object.keys(mods).join(' ');
    const vmap = (mapping.variantRules || []).find((r) => (!r.pattern || new RegExp(r.pattern).test(v.hashes[0].pattern))
      && (!r.style || new RegExp(r.style).test(styleStr)) && (!r.mod || new RegExp(r.mod).test(modStr))) || {};
    return {
      id: `${cmp}${variants.length > 1 ? '-v' + (vi + 1) : ''}`,
      pattern: v.hashes[0].pattern, hashes: v.hashes.map((h) => ({ hash: h.hash, instances: h.insts.length, pattern: h.pattern })),
      jaccardMerged: v.sim, instances: all.length, pages: pages.size, properties: props,
      sampleUrls: [...pages].slice(0, 6).map((u) => u.replace(ORIGIN, '')), repFile: rep ? rep.file : '', repUrl: rep ? rep.url : all[0].pageUrl,
      modifiers: Object.entries(mods).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).slice(0, 10),
      styles: Object.entries(style).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).slice(0, 10),
      parents: [...new Set(all.map((i) => i.parent || '(page)'))],
      counts: { img: med('img'), a: med('a'), li: med('li'), h: med('h'), btn: med('btn'), input: med('input'), iframe: med('iframe'), video: med('video') },
      flags: { slick: all.some((i) => i.flags.slick), tablist: all.some((i) => i.flags.tablist), modal: all.some((i) => i.flags.modal), expanded: Math.max(...all.map((i) => i.flags.expanded)) },
      dataAttrs: [...new Set(all.flatMap((i) => i.flags.dataAttrs))].slice(0, 12),
      topLabel: Object.entries(labels).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || '',
      eds: vmap.eds || mapping.eds, category: vmap.category || mapping.category, note: vmap.note || '',
    };
  }).sort((a, b) => b.instances - a.instances);
  inventory.push({
    cmp, aemComponent: cmp, instances: insts.length, pages: new Set(insts.map((i) => i.pageUrl)).size,
    exactPatterns: hashes.length, variants: vOut.length,
    properties: vOut.reduce((o, v) => { for (const [k, n] of Object.entries(v.properties)) o[k] = (o[k] || 0) + n; return o; }, {}),
    eds: mapping.eds, category: mapping.category, complexity: mapping.complexity || '', rationale: mapping.rationale || '', mapped: !!MAP[cmp],
    variantList: vOut,
  });
}
const CAT_ORDER = { custom: 0, boilerplate: 1, 'default-content': 2, section: 3, chrome: 4 };
inventory.sort((a, b) => (CAT_ORDER[a.category] - CAT_ORDER[b.category]) || b.instances - a.instances);

// ---------- pages: AEM template families + EDS-block signatures ----------
const cmpEds = Object.fromEntries(inventory.map((c) => [c.cmp, c]));
const edsOf = (cmp) => { const c = cmpEds[cmp]; if (!c) return cmp; if (c.category === 'default-content') return 'text'; return c.category === 'custom' ? c.eds : c.eds; };
const pageSig = {};
for (const p of aemPages) {
  const seq = []; for (const c of p.seq) { const e = edsOf(c); if (seq[seq.length - 1] !== e) seq.push(e); }
  const fam = `${propOf(p.url)} · ${p.template || 'no-template'}`;
  pageSig[p.url] = { fam, blocks: seq, signature: `[${p.template || '-'}] ${seq.join('>')}` };
}
// rewrite pages.jsonl (keep integration signals from render-pages.js)
if (fs.existsSync(path.join(CF, 'pages.jsonl'))) {
  const rp = rdl('pages.jsonl');
  if (!fs.existsSync(path.join(CF, 'pages.generic.jsonl'))) fs.copyFileSync(path.join(CF, 'pages.jsonl'), path.join(CF, 'pages.generic.jsonl'));
  const out = rp.map((r) => { const s = pageSig[r.url]; return s ? { ...r, blocks: s.blocks, blockCount: s.blocks.length, signature: s.signature, family: s.fam } : r; });
  fs.writeFileSync(path.join(CF, 'pages.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
}
// layouts.json: one template entry per (family, signature); family = property · AEM template
const fams = {};
for (const [url, s] of Object.entries(pageSig)) {
  const k = s.fam + '||' + s.signature;
  const t = fams[k] || (fams[k] = { name: s.fam.replace(/[^a-z0-9·-]+/gi, '-').replace(/-·-/g, '·'), family: s.fam, signature: s.signature, rendered: 0, estPop: 0, urls: [], sections: {}, locales: {}, blockCountMode: {} });
  t.rendered++; t.estPop++; if (t.urls.length < 8) t.urls.push(url);
  for (const b of s.blocks) t.sections[b] = (t.sections[b] || 0) + 1;
}
const tlist = Object.values(fams).sort((a, b) => b.estPop - a.estPop);
fs.writeFileSync(path.join(CF, 'layouts.json'), JSON.stringify({ captured: new Date().toISOString(), renderedPages: aemPages.length, distinctSignatures: tlist.length, method: 'AEM page template meta + component sequence', templates: tlist }, null, 1));

// ---------- dashboard-compatible block catalog + instances ----------
// gallery key ("base"): EDS target block for boilerplate; "custom:<cmp>" for custom blocks;
// default content / sections / chrome get their own galleries.
const baseOf = (c) => (c.category === 'custom' ? 'custom:' + c.eds : c.category === 'default-content' ? 'default-content' : c.category === 'section' ? 'section' : c.category === 'chrome' ? c.eds : c.eds);
const catVariants = [];
for (const c of inventory) {
  for (const v of c.variantList) {
    if (!v.repFile) continue;
    catVariants.push({
      base: baseOf({ ...c, eds: v.eds, category: v.category }), key: `${c.cmp}::${v.hashes[0].hash}`, cmp: c.cmp, category: v.category, eds: v.eds,
      instances: v.instances, pagesFound: v.pages, repFile: v.repFile, repUrl: v.repUrl,
      samples: v.sampleUrls.map((u) => ({ url: ORIGIN + u })), topLabel: v.topLabel, pattern: v.pattern, exactPatterns: v.hashes.length,
      modifiers: v.modifiers, properties: v.properties, id: v.id,
    });
  }
}
const byBase = {};
for (const v of catVariants) { const b = byBase[v.base] || (byBase[v.base] = { base: v.base, variants: 0, instances: 0, category: v.category }); b.variants++; b.instances += v.instances; }
const contentInst = comps.filter((c) => !c.layout && !c.chrome).length;
fs.writeFileSync(path.join(CF, 'block-catalog.json'), JSON.stringify({
  captured: new Date().toISOString(), method: 'AEM component tag-pattern analysis', jaccard: JACCARD,
  totalInstances: comps.length, contentInstances: contentInst, totalVariants: catVariants.length,
  baseSummary: Object.values(byBase).sort((a, b) => b.instances - a.instances), variants: catVariants,
}, null, 1));
const repByKey = {}; for (const c of inventory) for (const v of c.variantList) for (const h of v.hashes) repByKey[c.cmp + ':' + h.hash] = { file: v.repFile, base: baseOf({ ...c, eds: v.eds, category: v.category }) };
if (fs.existsSync(path.join(CF, 'blocks.jsonl')) && !fs.existsSync(path.join(CF, 'blocks.generic.jsonl'))) fs.copyFileSync(path.join(CF, 'blocks.jsonl'), path.join(CF, 'blocks.generic.jsonl'));
fs.writeFileSync(path.join(CF, 'blocks.jsonl'), comps.map((c, i) => { const r = repByKey[c.cmp + ':' + c.hash] || {}; return JSON.stringify({ pageUrl: c.pageUrl, ord: i, type: r.base || c.cmp, cmp: c.cmp, signature: c.hash, textLen: c.textLen, label: c.label, file: r.file || '', captured: !!r.file }); }).join('\n') + '\n');

fs.writeFileSync(path.join(CF, 'aem-block-inventory.json'), JSON.stringify({
  captured: new Date().toISOString(), jaccard: JACCARD, pages: aemPages.length, componentInstances: comps.length,
  components: inventory.length, exactPatterns: inventory.reduce((a, c) => a + c.exactPatterns, 0), structuralVariants: inventory.reduce((a, c) => a + c.variants, 0),
  // per-variant (variantRules can move a variant out of its component's default category)
  byCategory: (() => {
    const o = {};
    for (const c of inventory) for (const v of c.variantList) {
      const k = v.category; o[k] = o[k] || { components: new Set(), edsBlocks: new Set(), variants: 0, instances: 0 };
      o[k].components.add(c.cmp); o[k].edsBlocks.add(v.eds); o[k].variants++; o[k].instances += v.instances;
    }
    for (const x of Object.values(o)) { x.components = [...x.components]; x.edsBlocks = [...x.edsBlocks]; }
    return o;
  })(),
  inventory,
}, null, 1));

// ---------- summary ----------
console.log(`pages=${aemPages.length} instances=${comps.length} components=${inventory.length} exactPatterns=${inventory.reduce((a, c) => a + c.exactPatterns, 0)} variants=${inventory.reduce((a, c) => a + c.variants, 0)}`);
for (const c of inventory) console.log(`${c.category.padEnd(16)} ${c.cmp.padEnd(24)} → ${String(c.eds).padEnd(22)} inst=${String(c.instances).padStart(5)} pg=${String(c.pages).padStart(4)} patterns=${String(c.exactPatterns).padStart(3)} variants=${c.variants}${c.mapped ? '' : '  (heuristic)'}  ${JSON.stringify(c.properties)}`);
console.log(`layout families: ${new Set(tlist.map((t) => t.family)).size} (${tlist.length} signatures)`);
