/*
 * aem-overlay.js — dashboard overlay for AEM-Sites sources analysed with
 * capture-aem-components.js + consolidate-aem-components.js.
 *
 * build-dashboard.js calls apply() when <CF>/aem-block-inventory.json exists. It:
 *   - rebuilds the block galleries per EDS target (boilerplate) / per custom block,
 *     each specimen tagged with its AEM component, category, EDS target and tag pattern
 *   - adds DATA.block_classification (every structural variant, custom vs boilerplate)
 *   - rewrites the block-related narrative (lead, findings, recommendations, methodology)
 * and returns patch() which injects the classification section into the template.
 */
const fs = require('fs');
const path = require('path');

const CAT_LABEL = { custom: 'Custom', boilerplate: 'Boilerplate', 'default-content': 'Default content', section: 'Section', chrome: 'Header / Footer' };
const EDS_LABEL = { hero: 'Hero', cards: 'Cards', columns: 'Columns', carousel: 'Carousel', accordion: 'Accordion', tabs: 'Tabs', video: 'Video', embed: 'Embed', table: 'Table', form: 'Form', quote: 'Quote', search: 'Search', breadcrumbs: 'Breadcrumbs', fragment: 'Fragment', 'default-content': 'Default content', section: 'Section (layout)', header: 'Header', footer: 'Footer' };
const BOILER_ORDER = ['hero', 'cards', 'columns', 'carousel', 'accordion', 'tabs', 'video', 'embed', 'table', 'quote', 'search', 'breadcrumbs', 'form', 'fragment'];

function apply({ DATA, METHOD, METHOD_IMAGES, IMAGES, CF, CFG, b64, SITE_ORIGIN, nf }) {
  const inv = JSON.parse(fs.readFileSync(path.join(CF, 'aem-block-inventory.json'), 'utf8'));
  const PROPS = CFG.properties || [];
  const propLabel = (k) => (PROPS.find((p) => p.key === k) || {}).label || k;
  const strip = (u) => (u || '').replace(SITE_ORIGIN, '');

  // ---------- flatten variants ----------
  const rows = [];
  for (const c of inv.inventory) {
    for (const v of c.variantList) {
      rows.push({ c, v, cat: v.category || c.category, eds: v.eds || c.eds });
    }
  }
  // images
  for (const k of Object.keys(IMAGES)) delete IMAGES[k];
  let n = 0;
  const imgKey = {};
  for (const r of rows) if (r.v.repFile) { const k = `a${n++}.jpg`; IMAGES[k] = b64('blocks', r.v.repFile); imgKey[r.c.cmp + '|' + r.v.id] = k; }

  // ---------- galleries ----------
  const galKey = (r) => (r.cat === 'custom' ? 'custom:' + r.eds : r.cat === 'boilerplate' ? r.eds : r.cat === 'chrome' ? r.eds : r.cat);
  const gal = {};
  for (const r of rows) { if (!r.v.repFile) continue; (gal[galKey(r)] = gal[galKey(r)] || []).push(r); }
  const order = Object.keys(gal).sort((a, b) => {
    const rank = (k) => { if (BOILER_ORDER.includes(k)) return BOILER_ORDER.indexOf(k); if (k.startsWith('custom:')) return 100; if (k === 'default-content') return 200; if (k === 'section') return 300; return 400; };
    return rank(a) - rank(b) || gal[b].reduce((s, r) => s + r.v.instances, 0) - gal[a].reduce((s, r) => s + r.v.instances, 0);
  });
  const nameOf = (k) => (k.startsWith('custom:') ? 'Custom · ' + k.slice(7) : EDS_LABEL[k] || k);
  DATA.galleries = order.map((k, i) => {
    const rs = gal[k].sort((a, b) => b.v.instances - a.v.instances);
    const cat = rs[0].cat;
    return {
      name: nameOf(k), section: `3.${i + 1}`, category: cat,
      traits: [{ trait: CAT_LABEL[cat], count: '' }, { trait: `${rs.length} variants`, count: String(rs.reduce((s, r) => s + r.v.instances, 0)) },
        { trait: 'AEM: ' + [...new Set(rs.map((r) => r.c.cmp))].join(', '), count: '' }],
      variants: rs.map((r) => ({
        id: r.v.id + (r.v.topLabel ? ' — ' + r.v.topLabel.slice(0, 32) : ''),
        traits: [`AEM ${r.c.cmp}`, `${CAT_LABEL[r.cat]} → ${r.eds}`, `${r.v.instances} inst`, `${r.v.hashes.length} tag pattern${r.v.hashes.length > 1 ? 's' : ''}`, ...r.v.modifiers.slice(0, 3).map((m) => m.replace(/\(\d+\)$/, ''))].join(' · '),
        pages: String(r.v.pages), model: `${CAT_LABEL[r.cat]} → EDS ${r.eds}  |  tag pattern: ${r.v.pattern.slice(0, 400)}`,
        url: strip(r.v.repUrl), img: imgKey[r.c.cmp + '|' + r.v.id] || '',
      })),
    };
  });

  // ---------- classification table ----------
  DATA.block_classification = {
    properties: PROPS.map((p) => ({ key: p.key, label: p.label })),
    totals: {
      pages: inv.pages, instances: inv.componentInstances, components: inv.components, exactPatterns: inv.exactPatterns, variants: inv.structuralVariants,
      byCategory: rows.reduce((o, r) => { const k = r.cat; o[k] = o[k] || { variants: 0, instances: 0, components: new Set() }; o[k].variants++; o[k].instances += r.v.instances; o[k].components.add(r.c.cmp); return o; }, {}),
    },
    rows: rows.map((r) => ({
      cat: r.cat, cmp: r.c.cmp, id: r.v.id, eds: r.eds, pattern: r.v.pattern, patterns: r.v.hashes.length, merged: r.v.jaccardMerged,
      instances: r.v.instances, pages: r.v.pages, props: r.v.properties, mods: r.v.modifiers.slice(0, 5), styles: r.v.styles.slice(0, 4),
      label: r.v.topLabel, url: strip(r.v.repUrl), img: imgKey[r.c.cmp + '|' + r.v.id] || '',
      why: r.v.note || r.c.rationale, complexity: r.c.complexity || '', parents: r.v.parents,
    })),
  };
  for (const k of Object.keys(DATA.block_classification.totals.byCategory)) {
    const o = DATA.block_classification.totals.byCategory[k]; o.components = o.components.size;
  }
  const T = DATA.block_classification.totals.byCategory;
  const cnt = (k, f) => (T[k] ? T[k][f] : 0);

  // custom + boilerplate EDS targets (distinct blocks to build)
  const customBlocks = [...new Set(rows.filter((r) => r.cat === 'custom').map((r) => r.eds))];
  const boilerBlocks = [...new Set(rows.filter((r) => r.cat === 'boilerplate').map((r) => r.eds))];
  DATA.block_classification.customBlocks = customBlocks;
  DATA.block_classification.boilerBlocks = boilerBlocks;

  // ---------- summaries used by existing template widgets ----------
  DATA.blocktype_summary = DATA.galleries.map((g) => ({
    type: g.name, variants: String(g.variants.length), instances: String(g.variants.reduce((s, v) => s + (+v.traits.match(/(\d+) inst/)[1]), 0)),
    pct: Math.round(g.variants.length / rows.filter((r) => r.v.repFile).length * 100) + '%', eds: g.category === 'custom' ? 'Custom' : 'Standard',
  }));
  DATA.top40 = rows.filter((r) => r.cat !== 'section').sort((a, b) => b.v.instances - a.v.instances).slice(0, 20)
    .map((r, i) => ({ rank: String(i + 1), id: `${r.v.id} (${CAT_LABEL[r.cat]} → ${r.eds})`, type: r.c.cmp, instances: String(r.v.instances) }));

  DATA.blocks_lead = `Every one of the ${inv.pages} live pages was rendered and its AEM component tree walked. ${nf(inv.componentInstances)} component instances were fingerprinted by normalised HTML tag pattern (${inv.exactPatterns} exact patterns), merged by tag-path Jaccard similarity into ${inv.structuralVariants} structural variants across ${inv.components} AEM components, and each variant was classified as `
    + `CUSTOM (${cnt('custom', 'variants')} variants → ${customBlocks.length} bespoke EDS blocks), BOILERPLATE (${cnt('boilerplate', 'variants')} variants → ${boilerBlocks.length} standard EDS blocks: ${boilerBlocks.join(', ')}), default content, section layout, or header/footer. The classification table below lists every variant with its tag pattern; galleries show a cropped screenshot per variant.`;

  // KPIs
  const kv = (l) => DATA.kpis.find((k) => /Block variants/i.test(k.l));
  const k1 = kv(); if (k1) { k1.n = String(inv.structuralVariants); k1.l = 'Structural block variants'; }
  DATA.kpis.splice(3, 0, { n: String(customBlocks.length), l: 'Custom EDS blocks', c: 'alt' }, { n: String(boilerBlocks.length), l: 'Boilerplate EDS blocks', c: '' });
  DATA.metrics = DATA.metrics.filter((m) => !/Block (instances|variants)/.test(m.metric)).concat([
    { metric: 'AEM component instances', value: nf(inv.componentInstances) },
    { metric: 'Distinct AEM components', value: String(inv.components) },
    { metric: 'Exact tag patterns', value: String(inv.exactPatterns) },
    { metric: 'Structural variants (Jaccard ≥ ' + inv.jaccard + ')', value: String(inv.structuralVariants) },
    { metric: 'Custom blocks / variants', value: `${customBlocks.length} / ${cnt('custom', 'variants')}` },
    { metric: 'Boilerplate blocks / variants', value: `${boilerBlocks.length} / ${cnt('boilerplate', 'variants')}` },
  ]);

  // exec summary + findings + recommendations: replace the generic block sentences
  DATA.exec_summary = DATA.exec_summary.filter((s) => !/block instances were captured/.test(s));
  DATA.exec_summary.splice(3, 0,
    `All ${inv.pages} pages were rendered (no sampling). ${nf(inv.componentInstances)} AEM component instances reduce to ${inv.components} components, ${inv.exactPatterns} exact HTML tag patterns and ${inv.structuralVariants} structural variants.`,
    `Classification: ${customBlocks.length} CUSTOM blocks (${customBlocks.join(', ')}) and ${boilerBlocks.length} BOILERPLATE blocks (${boilerBlocks.join(', ')}); ${cnt('default-content', 'variants')} variants are plain default content and ${cnt('section', 'variants')} are section layouts.`);
  DATA.observations = DATA.observations.filter((o) => !/unknown\/custom/.test(o));
  const topCustom = rows.filter((r) => r.cat === 'custom').sort((a, b) => b.v.instances - a.v.instances).slice(0, 4);
  DATA.observations.unshift(`Highest-volume custom variants: ${topCustom.map((r) => `${r.v.id} → ${r.eds} (${r.v.instances} inst, ${r.v.pages} pages)`).join('; ')}.`);
  const shared = rows.filter((r) => Object.keys(r.v.properties).length >= 2 && r.cat !== 'section' && r.cat !== 'chrome');
  DATA.observations.unshift(`${shared.length} of ${rows.filter((r) => r.cat !== 'section' && r.cat !== 'chrome').length} content variants share an identical tag pattern across two or more properties (${PROPS.map((p) => p.label).join(' / ')}) — one EDS block library serves all three sites; differences are theme-level (header/footer, colours).`);
  DATA.recommendations = DATA.recommendations.filter((r) => !/unknown\/custom/.test(r));
  DATA.recommendations.unshift(
    `Build the ${boilerBlocks.length} boilerplate blocks first from the Block Collection (${boilerBlocks.join(', ')}); they cover ${nf(cnt('boilerplate', 'instances'))} component instances.`,
    `Scope the ${customBlocks.length} custom blocks as bespoke development (${customBlocks.join(', ')}) — ${nf(cnt('custom', 'instances'))} instances; see the classification table for the tag-pattern evidence and rationale per variant.`,
    'Map AEM gridlayout/container background styles (bg*) to EDS section-metadata styles rather than blocks; text/title/image/button components become default content.');

  // ---------- methodology ----------
  METHOD.purpose = {
    intro: 'This companion explains how the analysis was produced: how every in-scope page was discovered and rendered, how AEM components were fingerprinted by their HTML tag patterns, how near-identical patterns were merged into structural variants, and how each variant was classified as a custom or boilerplate EDS block.',
    questions: ['Where do block boundaries come from?', 'What exactly is a "tag pattern" and how is it normalised?', 'How is custom vs boilerplate decided?'],
    tip: 'The Blocks & Components section opens with the full classification table — every variant, its tag pattern, usage per property and the reason for its category.',
    one_sentence: 'Every page is rendered, its real AEM component tree walked, each component instance reduced to a normalised HTML tag pattern, near-identical patterns merged by tag-path similarity, and every resulting variant mapped to an EDS block and classified Custom or Boilerplate.',
  };
  METHOD.stages = [
    { n: '1', title: 'URL discovery', lead: 'The Global EN sitemap seeds the crawl; the microsites are disallowed in robots.txt and absent from every sitemap, so they are discovered only by following links.', list: ['Sitemap seed (global/en).', 'Breadth-first link crawl restricted to /global/en, /dominoscolab, /yumlive.', 'AEM Sling component endpoints (_jcr_content/…html) and off-site redirects set aside.'], example: `${nf(inv.pages)} live HTML pages rendered; linked PDFs inventoried as documents.` },
    { n: '2', title: 'Render everything', lead: 'No sampling: every live page in scope is rendered in headless Chromium with a lazy-load scroll before analysis.', list: ['All pages fingerprinted.', 'Fixed/sticky overlays (header, cookie bar) hidden before cropping.', 'Up to two crops per distinct tag pattern, re-shot cleanly for each variant\u2019s representative.'], example: `${nf(inv.pages)} of ${nf(inv.pages)} pages analysed.` },
  ];
  METHOD.meta['Example data'] = `${inv.pages} pages · ${nf(inv.componentInstances)} component instances · ${inv.structuralVariants} variants`;
  METHOD.pipeline = [
    { n: '1', stage: 'URL discovery', what: 'Sitemap + scoped link crawl of every in-scope property (microsites are robots-disallowed / unsitemapped).' },
    { n: '2', stage: 'Render ALL pages', what: 'No sampling — every live 200 HTML page rendered in headless Chromium with lazy-load scroll.' },
    { n: '3', stage: 'AEM component tree', what: 'Walk aem-GridColumn / .cmp-container boundaries; the wrapper class names the AEM component.' },
    { n: '4', stage: 'Tag-pattern fingerprint', what: 'Normalised element-tag tree per component; nested components as @refs; repeats and rich text folded.' },
    { n: '5', stage: 'Variant clustering', what: 'Exact pattern hash, then Jaccard ≥ ' + inv.jaccard + ' on root-to-leaf tag-path sets merges near-identical patterns.' },
    { n: '6', stage: 'Classification', what: 'Each variant → EDS target + Custom / Boilerplate / Default content / Section / Header-Footer.' },
    { n: '7', stage: 'Integration scan', what: 'Script/iframe hosts, JS globals and XHR/fetch API calls.' },
  ];
  METHOD.detection = {
    lead: 'Block boundaries are not guessed from CSS heuristics: AEM Sites wraps every authored component in a div whose first class is the component resource name (e.g. iconcards, leftrightcontent, homepageherobanner). The pipeline walks that real component tree and fingerprints each instance by its HTML tag pattern.',
    tiers: [
      { tier: '1', signal: 'Component boundary', example: 'element with class aem-GridColumn, or a direct child of .aem-Grid / .cmp-container → one component instance' },
      { tier: '2', signal: 'Component name', example: 'first non-aem class token = AEM component (style-system tokens after it, e.g. "relatedcontent list")' },
      { tier: '3', signal: 'Tag pattern', example: 'iconcards → div(div(a(img,div(rte)+,div))+) ; nested components become @text / @iconcards' },
      { tier: '4', signal: 'Semantic markers', example: 'role=tabpanel/dialog/navigation, aria-expanded [exp], iframe host [youtube], input[type], slick runtime' },
      { tier: '5', signal: 'Classification', example: 'evidence-reviewed mapping per component (with per-variant rules) → EDS block + Custom / Boilerplate' },
    ],
    note: 'Normalisation: text is ignored; inline tags (span/strong/em/b/i/br…) are transparent; runs of p/ul/ol/h1–h6 fold to "rte"; identical consecutive siblings fold to "x+" (3 cards = 4 cards); bare single-child div chains collapse; slick clones are dropped.',
  };
  METHOD.taxonomy = {
    lead: 'Every structural variant gets one of five categories.',
    rows: [
      { type: 'Custom', terms: `${cnt('custom', 'variants')} variants · ${cnt('custom', 'instances')} instances — needs a bespoke EDS block (data-driven listing, bespoke interaction, or a layout with no Block Collection equivalent)` },
      { type: 'Boilerplate', terms: `${cnt('boilerplate', 'variants')} variants · ${cnt('boilerplate', 'instances')} instances — maps to a standard EDS / Block Collection block, styled per brand` },
      { type: 'Default content', terms: `${cnt('default-content', 'variants')} variants · ${cnt('default-content', 'instances')} instances — text, title, image, button: authored as EDS default content` },
      { type: 'Section', terms: `${cnt('section', 'variants')} variants · ${cnt('section', 'instances')} instances — container/gridlayout → EDS section + section-metadata style` },
      { type: 'Header / Footer', terms: `${cnt('chrome', 'variants')} variants — experience-fragment chrome → EDS header/footer fragments (one per property)` },
    ],
    note: 'Custom vs boilerplate is decided per variant from its tag pattern and behaviour flags, not from the component name alone.',
  };
  METHOD.fingerprint = {
    lead: 'Two structural measurements per component instance:',
    rows: [
      { characteristic: 'tag pattern', values: 'e.g. div(div(img,div(rte)+,div(a))+)', meaning: 'Normalised element tree — the exact-match key (hashed).' },
      { characteristic: 'tag-path set', values: 'e.g. /div/div/a/img, /div/div/a/div/rte', meaning: 'Root-to-leaf paths — used for Jaccard similarity between patterns.' },
      { characteristic: 'modifiers / style tokens', values: 'e.g. threeColumn, images, bgDigitalDarkBlue', meaning: 'Author-selectable options → EDS block variants / section styles.' },
      { characteristic: 'behaviour flags', values: 'slick, tablist, aria-expanded, dialog, data-*', meaning: 'Separates interactive blocks from static ones.' },
    ],
  };
  METHOD.consolidation = {
    lead: `${nf(inv.componentInstances)} component instances → ${inv.exactPatterns} exact tag patterns → ${inv.structuralVariants} structural variants.`,
    exact_title: 'Exact pattern match', exact: 'Instances of the same AEM component with an identical normalised tag pattern share one hash.',
    weighted_title: 'Jaccard merge', weighted_lead: `Within a component, a pattern whose tag-path set overlaps an existing variant by ≥ ${inv.jaccard} (Jaccard) is merged into it — absorbing optional fields authors omit — otherwise it starts a new variant.`,
    weights: [
      { characteristic: 'AEM component', weight: '—', when: 'only instances of the same component are compared' },
      { characteristic: 'tag pattern hash', weight: 'exact', when: 'identical normalised tree' },
      { characteristic: 'tag-path Jaccard', weight: '≥ ' + inv.jaccard, when: 'near-identical tree (optional field present/absent)' },
    ],
    idnote: 'Variant IDs are <component>-v<n>, ordered by instance count.',
  };
  METHOD.template_discovery = {
    lead: 'Page templates come from the AEM page-template meta tag (meta[name=template]) per property, refined by the ordered component sequence.',
    example: `${inv.pages} pages → ${DATA.templates.length} property · template families.`,
  };
  METHOD.limitations = [
    'Classification of custom vs boilerplate is evidence-based but is a recommendation — confirm with the build team in Human Review.',
    'Hidden states (collapsed accordion panels, inactive slides, modals) are fingerprinted structurally but screenshots show the visible state.',
    'Dynamic listings (articlelisting) render server-side pages of results; their AJAX endpoints were inventoried, not executed exhaustively.',
    'Documents (PDF) are inventoried, not rendered.',
  ];
  METHOD.bottom_line = `${inv.pages} pages reduce to ${customBlocks.length} custom + ${boilerBlocks.length} boilerplate EDS blocks, plus default content and section styles.`;
  // worked examples: the highest-volume boilerplate and custom variants, with their real tag patterns
  const exB = rows.filter((r) => r.cat === 'boilerplate' && r.v.repFile).sort((a, b) => b.v.instances - a.v.instances)[0];
  const exC = rows.filter((r) => r.cat === 'custom' && r.v.repFile).sort((a, b) => b.v.instances - a.v.instances)[0];
  METHOD.examples_intro = 'Two real variants traced through the pipeline: the screenshot, its AEM component, its normalised tag pattern, and the resulting classification.';
  METHOD.examples = [exB, exC].filter(Boolean).map((r, i) => ({
    title: `Example ${'AB'[i]} — ${CAT_LABEL[r.cat]}: AEM ${r.c.cmp} → EDS ${r.eds}`,
    img: i === 0 ? 'cards-diagram.jpg' : 'unknown-diagram.jpg',
    desc: `Tag pattern: ${r.v.pattern.slice(0, 260)} · ${r.v.instances} instances on ${r.v.pages} pages · source ${strip(r.v.repUrl)}`,
    reading: r.v.note || r.c.rationale,
  }));
  if (exB) METHOD_IMAGES['cards-diagram.jpg'] = b64('blocks', exB.v.repFile);
  if (exC) METHOD_IMAGES['unknown-diagram.jpg'] = b64('blocks', exC.v.repFile);

  return { patch };
}

// ---------- template injection ----------
function patch(html, must) {
  // gallery rail + review seeding honour the per-gallery category
  must("const custom=/unknown/i.test(g.name);", "const custom=g.category?g.category==='custom':/unknown/i.test(g.name);");
  must("var t=FAMILY_TYPE[fam]||'Custom', cx=FAMILY_CX[fam]||'Medium';", "var t=g.category?(g.category==='custom'?'Custom':'Core'):(FAMILY_TYPE[fam]||'Custom'), cx=g.category==='custom'?'Complex':(FAMILY_CX[fam]||'Medium');");
  // classification section at the top of the Blocks view
  must('   <div class="block-title"><h3>Base block types</h3><span class="tag">summary by type</span></div>',
    '   ${typeof renderAemClass===\'function\'&&DATA.block_classification?renderAemClass():\'\'}\n'
    + '   <div class="block-title"><h3>Base block types</h3><span class="tag">summary by type</span></div>');
  must('  drawGallery(0);\n};', '  drawGallery(0);\n  if(DATA.block_classification)wireAemClass();\n};');
  must('renderers.blocks=()=>{', AEM_JS + '\nrenderers.blocks=()=>{');
  return html;
}

const AEM_JS = String.raw`
const AEM_CAT={custom:{l:'Custom',c:'#c2410c',bg:'#fff4ed'},boilerplate:{l:'Boilerplate',c:'#1a7f4b',bg:'#eef8f2'},'default-content':{l:'Default content',c:'#5b6472',bg:'#f4f5f7'},section:{l:'Section',c:'#2d6cdf',bg:'#eef3fd'},chrome:{l:'Header / Footer',c:'#6b3fa0',bg:'#f5f0fb'}};
function renderAemClass(){
  const B=DATA.block_classification,T=B.totals,C=T.byCategory||{};
  const k=(n,l,c)=>'<div class="panel panel-pad" style="text-align:center;border-left:5px solid '+c+'"><div style="font-size:24px;font-weight:700;color:'+c+'">'+n+'</div><div class="cap">'+l+'</div></div>';
  const g=(c,f)=>C[c]?C[c][f]:0;
  return '<div class="block-title"><h3>Block classification — Custom vs Boilerplate</h3><span class="tag">HTML tag-pattern analysis · all '+T.pages+' pages</span></div>'
   +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:6px 0 14px">'
   +k(T.instances.toLocaleString(),'AEM component<br>instances','#20242c')
   +k(T.components,'distinct AEM<br>components','#20242c')
   +k(T.exactPatterns,'exact HTML<br>tag patterns','#20242c')
   +k(T.variants,'structural<br>variants','#20242c')
   +k(B.customBlocks.length+' <span style="font-size:13px">('+g('custom','variants')+' var)</span>','<b style="color:#c2410c">CUSTOM</b> EDS blocks','#c2410c')
   +k(B.boilerBlocks.length+' <span style="font-size:13px">('+g('boilerplate','variants')+' var)</span>','<b style="color:#1a7f4b">BOILERPLATE</b> EDS blocks','#1a7f4b')
   +k(g('default-content','variants'),'default-content<br>variants','#5b6472')
   +k(g('section','variants'),'section-layout<br>variants','#2d6cdf')
   +'</div>'
   +'<div class="panel panel-pad" style="margin-bottom:10px"><div style="display:flex;flex-wrap:wrap;gap:18px;font-size:12.5px">'
   +'<div><b style="color:#c2410c">Custom blocks:</b> '+B.customBlocks.map(esc).join(', ')+'</div>'
   +'<div><b style="color:#1a7f4b">Boilerplate blocks:</b> '+B.boilerBlocks.map(esc).join(', ')+'</div></div></div>'
   +'<div class="panel panel-pad"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'
   +'<h4 style="margin:0">Every structural variant — tag pattern, usage and classification</h4>'
   +'<div id="aem-fb" style="display:flex;gap:6px;font-size:12px;flex-wrap:wrap">'
   +['all','custom','boilerplate','default-content','section','chrome'].map(c=>'<button class="aem-fb" data-cat="'+c+'" style="cursor:pointer;border:1px solid #ccc;border-radius:6px;padding:3px 10px;background:'+(c==='all'?'#20242c':'#fff')+';color:'+(c==='all'?'#fff':'#000')+'">'+(c==='all'?'All':AEM_CAT[c].l)+'</button>').join('')
   +'</div></div>'
   +'<div class="toolbar" style="margin:8px 0"><label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="aem-search" placeholder="Filter by component, EDS block, tag pattern…"></label><span class="count-note" id="aem-count"></span></div>'
   +'<div style="max-height:640px;overflow:auto"><table class="data" style="font-size:12px"><thead><tr><th>Shot</th><th>Category</th><th>AEM component / variant</th><th>EDS target</th><th style="min-width:280px">Normalised HTML tag pattern</th><th class="num" title="exact tag patterns merged into this variant">Pat.</th><th class="num">Inst.</th><th class="num">Pages</th>'
   +B.properties.map(p=>'<th class="num" title="instances on '+esc(p.label)+'">'+esc(p.label)+'</th>').join('')
   +'<th>Modifiers / styles</th><th style="min-width:240px">Why</th></tr></thead><tbody id="aem-body"></tbody></table></div>'
   +'<div class="cap" style="margin-top:6px">Click a thumbnail to enlarge. Pattern legend: rte = rich-text run (p/ul/ol/h*), x+ = repeated sibling, @name = nested AEM component, [exp] = aria-expanded, [tabpanel]/[dialog] = ARIA role.</div></div>';
}
function wireAemClass(){
  const B=DATA.block_classification;let cat='all';
  const ORDER={custom:0,boilerplate:1,'default-content':2,section:3,chrome:4};
  const rows=B.rows.slice().sort((a,b)=>(ORDER[a.cat]-ORDER[b.cat])||b.instances-a.instances);
  const body=$('#aem-body');
  const draw=q=>{
    const rs=rows.filter(r=>(cat==='all'||r.cat===cat)&&(!q||(r.cmp+' '+r.id+' '+r.eds+' '+r.pattern+' '+r.label+' '+(r.mods||[]).join(' ')).toLowerCase().includes(q)));
    body.innerHTML=rs.map((r,i)=>{const c=AEM_CAT[r.cat]||AEM_CAT.custom;
      const th=r.img&&img(r.img)?'<img src="'+img(r.img)+'" data-i="'+rows.indexOf(r)+'" class="aem-th" style="width:120px;max-height:70px;object-fit:cover;object-position:top;border-radius:4px;cursor:zoom-in;border:1px solid #e3e5e8">':'<span style="color:#aaa;font-size:10px">hidden / layout</span>';
      return '<tr style="background:'+c.bg+'"><td>'+th+'</td>'
       +'<td><span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:600;color:#fff;background:'+c.c+'">'+c.l+'</span>'+(r.complexity?'<div class="cap" style="margin-top:3px">'+esc(r.complexity)+'</div>':'')+'</td>'
       +'<td class="name-cell" style="font-size:12.5px">'+esc(r.cmp)+'<div class="mono" style="font-size:10.5px;color:var(--muted)">'+esc(r.id)+'</div>'+(r.label?'<div style="font-size:10.5px;color:var(--muted)">“'+esc(r.label.slice(0,40))+'”</div>':'')+(r.url?'<div><a href="'+esc(abs(r.url))+'" target="_blank" rel="noopener" style="font-size:10.5px">source ↗</a></div>':'')+'</td>'
       +'<td><b>'+esc(r.eds)+'</b></td>'
       +'<td class="mono" style="font-size:10.5px;word-break:break-all;max-width:420px" title="'+esc(r.pattern)+'">'+esc(r.pattern.length>220?r.pattern.slice(0,220)+'…':r.pattern)+'</td>'
       +'<td class="num">'+r.patterns+'</td><td class="num">'+r.instances+'</td><td class="num">'+r.pages+'</td>'
       +B.properties.map(p=>'<td class="num" style="color:'+((r.props||{})[p.key]?'inherit':'#bbb')+'">'+((r.props||{})[p.key]||'·')+'</td>').join('')
       +'<td style="font-size:10.5px">'+esc([...(r.mods||[]),...(r.styles||[])].slice(0,6).join(', '))+'</td>'
       +'<td style="font-size:11.5px">'+esc(r.why||'')+'</td></tr>';}).join('');
    $('#aem-count').textContent=rs.length+' of '+rows.length+' variants';
    body.querySelectorAll('.aem-th').forEach(t=>t.onclick=()=>{const r=rows[+t.dataset.i];curGallery=[{id:r.cmp+' · '+r.id,traits:(AEM_CAT[r.cat]||{}).l+' · '+r.eds,pages:String(r.pages),model:r.pattern,url:r.url,img:r.img,gname:r.cmp}];openLB(0);});
  };
  draw('');
  $('#aem-search').addEventListener('input',e=>draw(e.target.value.trim().toLowerCase()));
  document.querySelectorAll('.aem-fb').forEach(b=>b.addEventListener('click',()=>{cat=b.dataset.cat;document.querySelectorAll('.aem-fb').forEach(x=>{x.style.background='#fff';x.style.color='#000';});b.style.background='#20242c';b.style.color='#fff';draw(($('#aem-search').value||'').trim().toLowerCase());}));
}
`;

module.exports = { apply };
