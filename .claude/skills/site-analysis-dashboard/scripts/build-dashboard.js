#!/usr/bin/env node
/*
 * build-dashboard.js — reorganize a site analysis into the multi-section dashboard format.
 * Clones a dashboard TEMPLATE html, replaces the 5 data objects
 * (DATA, IMAGES, METHOD, METHOD_IMAGES, TEMPLATE_SHOTS) with this site's data,
 * writes <outFile>.
 *
 * Usage: node build-dashboard.js <catalogFolder>
 *   catalogFolder must contain config.json with:
 *     { catalogFolder, reportsDir, templateHtml, outFile,
 *       site, siteOrigin, scope, brandLine, eyebrow, accountName, locale }
 */
const fs = require('fs');
const path = require('path');

const CF = process.argv[2] || '.';
const CFG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8'));
const REPORTS = CFG.reportsDir;
const TEMPLATE = CFG.templateHtml;
const SITE_ORIGIN = CFG.siteOrigin || ('https://' + (CFG.site || ''));

const all = JSON.parse(fs.readFileSync(path.join(CF, 'urls-all.json')))['analysis-urls-all'];
const groups = JSON.parse(fs.readFileSync(path.join(CF, 'groups.json')));
const layouts = JSON.parse(fs.readFileSync(path.join(CF, 'layouts.json')));
const integ = JSON.parse(fs.readFileSync(path.join(CF, 'integrations.json')));
const shots = JSON.parse(fs.readFileSync(path.join(CF, 'shots.json'))).shots;
const blockCat = JSON.parse(fs.readFileSync(path.join(CF, 'block-catalog.json')));
const siteStructure = JSON.parse(fs.readFileSync(path.join(CF, 'site-structure.json')));
const documents = JSON.parse(fs.readFileSync(path.join(CF, 'documents.json')));
const urlGroups = JSON.parse(fs.readFileSync(path.join(CF, 'url-groups.json')));
const heatmap = JSON.parse(fs.readFileSync(path.join(CF, 'heatmap.json')));
const blockHeatmap = fs.existsSync(path.join(CF, 'block-heatmap.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'block-heatmap.json'))) : null;

const b64 = (dir, file) => { try { return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(CF, dir, file)).toString('base64'); } catch (e) { return ''; } };

// config-derived identifiers used for URL stripping + storage-key namespacing
const stripOrigin = (u) => (u || '').replace(SITE_ORIGIN, '').replace(/^https?:\/\/[^/]+/, (m) => (m === SITE_ORIGIN ? '' : m));
const NS = (CFG.site || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); // storage-key + filename namespace
const SITE_LABEL = CFG.site || SITE_ORIGIN.replace(/^https?:\/\//, ''); // prose label for the site

// ---------- consolidate layout families ----------
const famMap = {};
for (const t of layouts.templates) {
  const f = famMap[t.name] || (famMap[t.name] = { name: t.name, estPop: 0, rendered: 0, variants: 0, sections: {}, sampleUrl: t.urls[0], shot: null, shotEst: -1, sigs: [] });
  f.estPop += t.estPop; f.rendered += t.rendered; f.variants += 1; f.sigs.push(t.signature.replace(/>/g, ' › '));
  for (const [s, c] of Object.entries(t.sections)) f.sections[s] = (f.sections[s] || 0) + c;
}
// best shot per family
for (const s of shots) {
  if (!s.captured) continue; const f = famMap[s.name];
  if (f && s.estPop > f.shotEst) { f.shot = s.file; f.shotEst = s.estPop; }
}
const families = Object.values(famMap).sort((a, b) => b.estPop - a.estPop);
const FAM_DESC = {
  'data-table': 'Pages built around one or more data/spec tables — company network, IR data, and news bodies with tabular content.',
  'article-text': 'Text-led article pages — news releases, policy/statement pages and long-form body copy.',
  'section-nav-list': 'Section index / navigation-list pages — regional landing pages and link hubs.',
  'form-page': 'Pages containing a form (search/filter, contact, application) usually with supporting cards.',
  'media-article': 'Media-led articles pairing a lead image/video with descriptive text (brand media, exhibitions, guides).',
  'card-grid': 'Card / tile grids — business-segment landing pages, group-company modals, museum/history hubs.',
  'embed-page': 'Pages embedding third-party content via iframe (stock charts, external viewers, e-book readers).',
  media: 'Image / diagram-dominant pages (org charts, IR visuals) with minimal text.',
  'breadcrumb-page': 'Compact pages whose defining structure is a breadcrumb-framed text body.',
  'hero-landing': 'Landing pages led by a hero / main-visual followed by cards and feature lists (home / section fronts).',
  'minimal-page': 'Sparse pages with little decorative structure.',
};
const templates = families.map((f) => ({
  template: f.name, pages: String(f.estPop),
  description: (CFG.familyDescriptions || {})[f.name] || FAM_DESC[f.name] || '',
  keyblocks: f.sigs.slice(0, 1).join(', ') || f.name,
  sampleUrl: f.sampleUrl.replace(SITE_ORIGIN, ''),
  shot: f.shot ? `${f.name}.jpg` : '',
}));
const template_urls = families.map((f) => ({ template: f.name, url: f.sampleUrl.replace(SITE_ORIGIN, '') }));
// TEMPLATE_SHOTS keyed by "<name>.jpg"
const TEMPLATE_SHOTS = {};
for (const f of families) if (f.shot) TEMPLATE_SHOTS[`${f.name}.jpg`] = b64('shots', f.shot);

// ---------- block galleries (Saran gallery schema) ----------
// IMAGES keyed vN.jpg; each variant -> {id,traits,pages,model,url,img}
const IMAGES = {}; let imgN = 0;
const BASE_ORDER = ['hero', 'cards', 'columns', 'carousel', 'accordion', 'tabs', 'table', 'form', 'media', 'video', 'cta-banner', 'testimonial', 'iframe-embed', 'breadcrumbs', 'list', 'text', 'unknown'];
const BASE_LABEL = { text: 'Text', media: 'Media', video: 'Video', columns: 'Columns', table: 'Table', cards: 'Cards', list: 'List', form: 'Form', 'iframe-embed': 'Embed', breadcrumbs: 'Breadcrumbs', hero: 'Hero', unknown: 'Unknown / Custom', carousel: 'Carousel', accordion: 'Accordion', tabs: 'Tabs', 'cta-banner': 'CTA banner', testimonial: 'Testimonial' };
const galleries = [];
let secN = 0;
for (const base of BASE_ORDER) {
  const vs = blockCat.variants.filter((v) => v.base === base).sort((a, b) => b.instances - a.instances);
  if (!vs.length) continue;
  secN++;
  const variants = vs.map((v) => {
    const key = `v${imgN++}.jpg`;
    IMAGES[key] = b64('blocks', v.repFile);
    const feat = v.key.split('::')[1] || '';
    return {
      id: `${base}-${(v.topLabel || v.key.split('::')[1] || 'variant').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}-${v.instances}`,
      traits: (v.topLabel ? v.topLabel + ' · ' : '') + feat.replace(/\|/g, ' · ').slice(0, 48),
      pages: String(v.pagesFound), model: base,
      url: v.repUrl.replace(SITE_ORIGIN, ''), img: key,
    };
  });
  // traits summary for the gallery header
  const traitAgg = {};
  for (const v of vs) { const t = v.base; traitAgg[t] = (traitAgg[t] || 0) + v.instances; }
  galleries.push({
    name: base === 'iframe-embed' ? 'Embed' : (BASE_LABEL[base] || base),
    section: `3.${secN}`,
    traits: [{ trait: `${vs.length} variants`, count: String(vs.reduce((a, v) => a + v.instances, 0)) }],
    variants,
  });
}

// ---------- blocktype_summary + top variants ----------
const blocktype_summary = blockCat.baseSummary.map((b) => ({
  type: b.base, variants: String(b.variants), instances: String(b.instances),
  pct: Math.round(b.variants / blockCat.totalVariants * 100) + '%',
  eds: ['text','media','table','cards','list','breadcrumbs','hero','form','carousel','accordion','tabs','cta-banner','testimonial'].includes(b.base) ? 'Standard' : 'Custom',
}));
const top40 = blockCat.variants.slice().sort((a, b) => b.instances - a.instances).slice(0, 20)
  .map((v, i) => ({ rank: String(i + 1), id: (v.topLabel || v.base) + ' — ' + (v.key.split('::')[1] || '').slice(0, 24), type: v.base, instances: String(v.instances) }));

// ---------- coverage / structure / docs ----------
const livePages = groups.totalLivePages;
// Top-level URL groups with a meaningful page count (drop tiny/noise groups). For a
// multi-region site these are locales; for a single-locale site they are content sections.
const localeList = urlGroups.filter((g) => g.count >= 2 && g.group !== '/(root)')
  .map((g) => ({ locale: g.group.replace(/^\//, ''), pages: String(g.count) }));
// Decide whether the site is genuinely multi-locale. Explicit config wins; otherwise infer
// from the config.locale string ("... (single)" => single) or a small set of ISO-ish segments.
const localeStr = (CFG.locale || '').toLowerCase();
const isMultiLocale = (CFG.multiLocale === true) || (CFG.multiLocale !== false && !/single/.test(localeStr)
  && localeList.filter((l) => /^[a-z]{2}([-_/][a-z]{2})?$/i.test(l.locale)).length >= 3);
const GROUP_NOUN = isMultiLocale ? 'locales / regions' : 'sections';
const GROUP_NOUN_TITLE = isMultiLocale ? 'Locales / regions' : 'Sections';
const coverage_summary = [
  { metric: 'URLs crawled (all)', value: String(all.totalUrls + all.totalDocuments) },
  { metric: 'HTML responses', value: String(all.totalUrls) },
  { metric: 'Live HTML pages (200, deduped)', value: String(livePages) },
  { metric: 'Documents (PDF etc.)', value: String(all.totalDocuments) },
  { metric: 'Dead links (404)', value: String(all.statusBreakdown.clientError) },
  { metric: 'Timeouts / errors', value: String(all.statusBreakdown.errorTimeout) },
  { metric: 'Layout families', value: String(families.length) },
  { metric: 'Structural variants', value: String(layouts.distinctSignatures) },
  { metric: 'Block variants catalogued', value: String(blockCat.totalVariants) },
  { metric: 'URL discovery method', value: 'Full crawl (sitemaps were stubs)' },
];
const coverage_groups = siteStructure.map((s) => ({ path: s.path, pages: s.pages }));
const url_groups = urlGroups.map((g) => ({ group: g.group, urls: g.urls }));

// ---------- integrations ----------
// Split recognised services from the "Other third-party: <host>" catch-alls; the
// catch-alls are rolled into a single summary row so the table stays readable.
const recognisedIntg = integ.integrations.filter((i) => !/^Other third-party:/.test(i.name));
const otherIntg = integ.integrations.filter((i) => /^Other third-party:/.test(i.name));
const integrations = recognisedIntg.map((i) => ({
  name: i.name,
  purpose: i.category || {
    'Google Tag Manager': 'Tag management / analytics container', 'Consent (OneTrust/Cookiebot)': 'Cookie consent management',
    'Google Analytics': 'Web analytics', 'CDN/jQuery libs': 'Front-end libraries via CDN', 'Google Maps/static': 'Maps & static assets',
    'Google Ads/DoubleClick': 'Ad / remarketing tags', 'YouTube embed': 'Embedded video',
  }[i.name] || 'Third-party service',
  pages: String(i.hits), coverage: Math.min(100, Math.round(i.hits / (layouts.renderedPages) * 100)) + '%',
}));
if (otherIntg.length) {
  integrations.push({
    name: `Other third-party hosts (${otherIntg.length})`,
    purpose: 'Unclassified — misc. minor hosts (see integrations.json for full list)',
    pages: String(otherIntg.reduce((a, i) => a + i.hits, 0)), coverage: '',
  });
}
const recognisedCount = recognisedIntg.length;

// ---------- heatmap (Saran shape) ----------
const heatmap_pct = { integrations: heatmap.integrations, rows: heatmap.rows.map((r) => ({ template: r.template, pg: r.pg, cells: r.cellsPct })) };
const heatmap_counts = { integrations: heatmap.integrations, rows: heatmap.rows.map((r) => ({ template: r.template, pg: r.pg, cells: r.cellsCnt })) };
const block_heatmap_pct = blockHeatmap ? { integrations: blockHeatmap.integrations, rows: blockHeatmap.pct } : null;
const block_heatmap_counts = blockHeatmap ? { integrations: blockHeatmap.integrations, rows: blockHeatmap.counts } : null;

// ---------- assemble DATA ----------
const nf = (n) => Number(n).toLocaleString();
const DATA = {
  meta: { Site: CFG.site || SITE_ORIGIN.replace(/^https?:\/\//, ''), Scope: CFG.scope || 'Site analysis', 'Analysis date': all.captured.slice(0, 10), 'Report status': 'COMPLETE', 'Pages analyzed': `${nf(livePages)} live pages (of ${nf(all.totalUrls + all.totalDocuments)} URLs crawled)` },
  hero_eyebrow: CFG.eyebrow || (CFG.site || 'Site') + ' · Site Analysis',
  hero_title: CFG.heroTitle || ('Structural analysis of ' + (CFG.site || SITE_ORIGIN.replace(/^https?:\/\//, ''))),
  hero_sub: CFG.heroSub || ('A crawl of ' + (CFG.site || 'the site') + ', prepared to scope a migration to Adobe Edge Delivery Services. Pages were rendered, structurally fingerprinted, clustered into layout families and catalogued into reusable block variants with visual evidence.' + (CFG.cjk ? ' A CJK font was installed so non-Latin text renders correctly in every screenshot.' : '')),
  hero_locale: CFG.locale || (localeList.length + ' locales'),
  kpis: [
    { n: nf(livePages), l: 'Live HTML pages', c: '' },
    { n: String(families.length), l: 'Layout families', c: '' },
    { n: String(blockCat.totalVariants), l: 'Block variants', c: 'alt' },
    { n: nf(all.totalDocuments), l: 'Documents (PDF)', c: '' },
    { n: String(integrations.length), l: 'Integrations', c: '' },
    { n: String(localeList.length), l: GROUP_NOUN_TITLE, c: '' },
  ],
  metrics: [
    { metric: 'URLs crawled (all)', value: nf(all.totalUrls + all.totalDocuments) },
    { metric: 'HTML responses', value: nf(all.totalUrls) },
    { metric: 'Live HTML pages', value: nf(livePages) },
    { metric: 'Documents (PDF)', value: nf(all.totalDocuments) },
    { metric: 'Layout families', value: String(families.length) },
    { metric: 'Structural variants', value: String(layouts.distinctSignatures) },
    { metric: 'Block instances captured', value: nf(blockCat.totalInstances) },
    { metric: 'Block variants', value: String(blockCat.totalVariants) },
    { metric: 'Pages rendered & fingerprinted', value: String(layouts.renderedPages) },
    { metric: 'Third-party integrations', value: String(integrations.length) },
    { metric: 'Dead links (404)', value: String(all.statusBreakdown.clientError) },
  ],
  locales: localeList,
  exec_summary: (() => {
    const topLoc = localeList.slice(0, 3).map((l) => `${l.locale} (${l.pages})`).join(', ');
    const topFams = families.slice(0, 3).map((f) => `${f.name} (~${f.estPop})`).join(', ');
    const topIntg = recognisedIntg.slice(0, 3).map((i) => i.name).join(', ');
    return [
      `${nf(all.totalUrls + all.totalDocuments)} URLs were crawled across ${SITE_LABEL} (${CFG.discovery || 'discovered via sitemap/crawl'}).`,
      `After de-duplication, ${nf(livePages)} live HTML pages remain` + (localeList.length > 1 ? ` across ${localeList.length} ${GROUP_NOUN} — led by ${topLoc}.` : '.'),
      `Pages consolidate into ${families.length} layout families (from ${layouts.distinctSignatures} distinct structural signatures) — the largest: ${topFams}.`,
      `${nf(blockCat.totalInstances)} block instances were captured across a ${layouts.renderedPages}-page representative render set and consolidated into ${blockCat.totalVariants} block variants across ${blockCat.baseSummary.length} base types.`,
      recognisedCount ? `A scan identified ${recognisedCount} third-party integration${recognisedCount === 1 ? '' : 's'}${topIntg ? ' — led by ' + topIntg : ''}.` : 'No recognisable third-party script/iframe integrations were detected (analytics may be bundled at build time — see Integrations).',
      `${nf(all.totalDocuments)} linked document${all.totalDocuments === 1 ? '' : 's'} and ${all.statusBreakdown.clientError} dead link${all.statusBreakdown.clientError === 1 ? '' : 's'} (4xx) were recorded.`,
    ];
  })(),
  methodology: [
    CFG.discovery ? `URL discovery: ${CFG.discovery}.` : 'URL discovery via sitemap, with a crawl fallback for any area not covered.',
    'URL-pattern grouping: recurring patterns (≥2 pages) sampled, all long-tail unique pages rendered in full.',
    'Headless render' + (CFG.cjk ? ' (locale-aware, CJK font installed)' : '') + ' with lazy-load; structural fingerprint per page.',
    'Clustering of fingerprints into layout families; block instances cropped and consolidated into variants.',
    'Scan of script/iframe hosts and JS globals for third-party integrations.',
  ],
  blocks_lead: `${nf(blockCat.totalInstances)} block instances were captured across the ${layouts.renderedPages}-page render set and rolled up into ${blockCat.totalVariants} variants across ${blockCat.baseSummary.length} base block types` + (blockCat.baseSummary.some((b) => b.base === 'unknown') ? ' — including an "Unknown / Custom" group for composite blocks that match no standard signal' : '') + `. Explore each type's gallery below — every specimen shows a cropped screenshot; click any to view it full-size with its source page. The recognised families (cards, media, table, form, embed, breadcrumbs, hero) map to standard EDS blocks; "unknown" blocks need bespoke handling and the "text" base is plain body copy.`,
  templates, template_urls, blocktype_summary, top40, galleries,
  integrations_lead: recognisedCount
    ? `A scan across the ${layouts.renderedPages} rendered pages identified ${recognisedCount} third-party integration${recognisedCount === 1 ? '' : 's'} (by recognisable script/iframe host). Re-implementing these natively is a distinct migration workstream.`
    : `No third-party integrations were detected by recognisable script/iframe host across the ${layouts.renderedPages} rendered pages. Modern bundlers (e.g. Next.js — a __NEXT_DATA__ global was present) often inline analytics/tag code at build time, so it may not appear as a distinct external host; confirm with the site's tag manager.`,
  integrations,
  integration_notes: integ.integrations.length
    ? integ.integrations.map((i) => `${i.name}: detected on ${i.hits} page-hit(s) across the render set.`)
    : ['No external analytics/consent/CDN hosts were detected — likely bundled at build time.', 'Detected JS globals are listed under Observations.'],
  observations: (() => {
    const o = [];
    const top2 = families.slice(0, 2);
    if (top2.length >= 2) o.push(`The two largest families — ${top2[0].name} (~${top2[0].estPop} pages) and ${top2[1].name} (~${top2[1].estPop}) — dominate and are ideal for bulk import from one parser each.`);
    const unk = blockCat.baseSummary.find((b) => b.base === 'unknown');
    if (unk) o.push(`${unk.variants} "unknown/custom" block variants (${unk.instances} instances) match no standard signal and warrant a human review before build.`);
    if (localeList.length > 1) o.push(`Content spans ${localeList.length} ${GROUP_NOUN}; the same core templates recur across them, so blocks are highly reusable.`);
    if (siteStructure.length) o.push(`Largest site sections by page count: ${siteStructure.slice(0, 4).map((s) => `${s.path} (${s.pages})`).join(', ')}.`);
    (integ.globals || []).slice(0, 1).forEach((g) => o.push(`Front-end signal: the "${g.global}" JS global appears on ${g.count} pages${/next/i.test(g.global) ? ' — this is a Next.js application' : ''}.`));
    return o.length ? o : ['Patterns are summarised in the tables above.'];
  })(),
  heatmap_pct, heatmap_counts, block_heatmap_pct, block_heatmap_counts,
  coverage_lead: `${SITE_LABEL} was crawled — ${nf(all.totalUrls + all.totalDocuments)} URLs fetched, yielding ${nf(livePages)} live HTML pages` + (all.totalDocuments ? ` plus ${nf(all.totalDocuments)} documents` : '') + '. Browse the complete inventory below.',
  coverage_summary, coverage_groups, url_groups,
  site_structure: siteStructure,
  documents: documents.slice(0, 400),
  recommendations: (() => {
    const r = [];
    const top2 = families.slice(0, 2).filter(Boolean);
    if (top2.length) r.push(`Start with the high-volume families: ${top2.map((f) => `${f.name} (~${f.estPop}p)`).join(' and ')} cover the most pages — validating these first maximises coverage.`);
    r.push('Treat the largest layout families as a bulk-import track: one parser per family handles many pages.');
    if (groups.longTail) r.push(`Handle the ${groups.longTail} long-tail unique pages individually — they carry the distinctive blocks.`);
    const unk = blockCat.baseSummary.find((b) => b.base === 'unknown');
    if (unk) r.push(`Review the ${unk.variants} "unknown/custom" block variants and map each to a standard EDS block or a bespoke build.`);
    if (all.totalDocuments) r.push(`Plan the ${nf(all.totalDocuments)} linked documents as a separate asset-migration workstream, not page migration.`);
    if (integ.integrations.length) r.push('Re-implement the detected third-party integrations natively during the migration.');
    else r.push('Confirm analytics/consent tooling with the site owner — none was detectable by external host (likely bundled).');
    try {
      const be = fs.existsSync(path.join(CF, 'backend.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'backend.json'))) : null;
      if (be && be.services && be.services.length) {
        const fp = be.services.filter((s) => /^First-party/.test(s.category));
        if (fp.length) r.push(`Backend: ${fp.length} first-party micro-services (identity/auth, consent, telemetry, pricing/commerce, etc.) were observed in API traffic — these must be re-pointed or preserved, not just re-tagged. See "Probable backend integrations".`);
        r.push(`Backend: catalogue the ${be.services.length} probable backend integrations (inferred from XHR/fetch calls) as a distinct API/data workstream alongside the front-end tag migration.`);
      }
    } catch (e) { /* backend.json optional */ }
    if (localeList.length > 1 && isMultiLocale) r.push(`Localisation: build the block palette once and reuse it across all ${GROUP_NOUN}.`);
    return r;
  })(),
  appendix: [
    `Crawl completed with ${all.statusBreakdown.success} successful (200) responses; ${all.statusBreakdown.clientError} 4xx and ${all.statusBreakdown.errorTimeout} timeouts recorded for cleanup.`,
    `Render/fingerprint pass covered ${layouts.renderedPages} representative pages (all long-tail unique pages + sampled pattern groups); block-level capture produced ${nf(blockCat.totalInstances)} block screenshots.`,
    'Source URLs on every block variant and template link to the live page the specimen was captured from.',
    'Layout page-counts are extrapolated to the full population from URL-pattern group membership.',
  ],
};

// ---------- METHOD (reuse Saran methodology narrative, adapted) ----------
const topFam = families.slice(0, 2);
const METHOD = {
  meta: { 'Subject site': SITE_ORIGIN + '/', Document: 'Methodology & worked examples', Date: all.captured.slice(0, 10), 'Example data': `The real ${SITE_LABEL} analysis (${nf(livePages)} live pages, ${blockCat.totalVariants} block variants)` },
  purpose: {
    intro: 'This companion explains how the site-analysis report is produced: how pages are discovered across every locale and rendered, how content blocks are detected and typed, and how thousands of block instances consolidate into a compact set of reusable variants and layout families.',
    questions: ['How are the base block types defined?', 'How are pages grouped so the crawl stays tractable?', 'On what basis are block instances consolidated into variants?'],
    tip: 'Jump to the two worked examples near the bottom — a news page and a business landing page traced through the whole process.',
    one_sentence: 'Every page is rendered in a real browser, its content split into blocks, each block classified against a fixed list of base types, its structure measured, and near-identical blocks merged into variants — while whole pages are clustered into layout families.',
  },
  pipeline: [
    { n: '1', stage: 'URL discovery', what: 'Find every page domain-wide (sitemap → crawl → browser fallback).' },
    { n: '2', stage: 'URL-pattern grouping', what: 'Group live pages by path pattern; sample repeats, keep all long-tail.' },
    { n: '3', stage: 'Render & cleanup', what: 'Headless browser render; trigger lazy content; locale-aware, CJK font.' },
    { n: '4', stage: 'Block detection', what: 'Walk the page; split into blocks; assign each a base type.' },
    { n: '5', stage: 'Fingerprinting', what: 'Record each block’s structural signature and each page’s block order.' },
    { n: '6', stage: 'Variant consolidation', what: 'Merge near-identical blocks into unique variants per base type.' },
    { n: '7', stage: 'Integration scan', what: 'Scan page HTML for third-party scripts/embeds and JS globals.' },
  ],
  stages: [
    { n: '1', title: 'URL discovery', lead: 'The goal is a complete, un-sampled list of pages across every locale. Three methods are tried in order, each falling back to the next.', list: ['Sitemap (fastest, most reliable when present).', 'Crawl (breadth-first, same-host links) as a fallback.', 'Headless-browser crawl (last resort for JS-heavy sites).'], example: `A full crawl seeded at the domain root fetched ${nf(all.totalUrls + all.totalDocuments)} URLs → ${nf(livePages)} live HTML pages + ${nf(all.totalDocuments)} documents across ${localeList.length} locales.` },
    { n: '2', title: 'URL-pattern grouping & rendering', lead: 'Live pages are grouped by final-path-level pattern so the render stays tractable without missing anything; representative pages and all long-tail uniques are rendered in a headless browser with a Japanese font installed.', list: ['Recurring patterns (≥2 pages) are sampled.', 'All long-tail unique pages are rendered in full.', 'Attachments/images are excluded from rendering.'], example: `${groups.patternGroups} recurring patterns were sampled and ${groups.longTail} long-tail pages rendered in full → a ${layouts.renderedPages}-page render set.` },
  ],
  detection: {
    lead: 'The cleaned page is walked top-down. Each candidate block is assigned a base type using a heuristic priority cascade over DOM signals — the first rule that matches wins.',
    tiers: [
      { tier: '1', signal: 'Class/id keywords', example: 'class contains "breadcrumb" → breadcrumbs; "hero/mv/keyvisual" → hero; "carousel/swiper" → carousel' },
      { tier: '2', signal: 'Semantic HTML', example: '<table> → table; <form>/inputs → form; <iframe> → embed' },
      { tier: '3', signal: 'Content heuristics', example: 'grid with ≥2 images / ≥4 links → cards; many <li> + links → list' },
      { tier: '4', signal: 'Media vs text', example: 'image with little text → media; heading + body → text' },
      { tier: '5', signal: 'Fallback', example: 'nothing distinctive → folded into the text/body catch-all' },
    ],
    note: `Blocks with composite structure but no recognised signal fall through to "unknown / custom" (${(blockCat.baseSummary.find((b) => b.base === 'unknown') || {}).variants || 0} variants, ${(blockCat.baseSummary.find((b) => b.base === 'unknown') || {}).instances || 0} instances) — the honest catch-all for bespoke structures, kept for manual review. Plain prose stays "text".`,
  },
  taxonomy: {
    lead: `The base types are a fixed vocabulary mirroring the standard AEM Edge Delivery / Block Collection conventions. Here are the types actually found on ${SITE_LABEL}, with their variant / instance counts.`,
    rows: blockCat.baseSummary.map((b) => ({ type: b.base, terms: `${b.variants} variants · ${b.instances} instances` })),
    note: 'Counts come from the block-level capture across the render set; the "text" base intentionally absorbs anything without a distinctive signal.',
  },
  fingerprint: {
    lead: 'Two structural measurements drive the analysis: a per-block signature (for variant dedup) and a per-page block order (for layout clustering).',
    rows: [
      { characteristic: 'block signature', values: 'tag + child histogram + feature flags', meaning: 'Identifies near-identical blocks of the same type.' },
      { characteristic: 'page fingerprint', values: 'e.g. hero › media › cards › text', meaning: 'Ordered list of a page’s top-level blocks.' },
      { characteristic: 'feature flags', values: 'img / table / list / form / iframe', meaning: 'Presence of key elements inside a block.' },
      { characteristic: 'link & image counts', values: 'bucketed (0–9+)', meaning: 'Separates dense grids from simple blocks.' },
    ],
  },
  consolidation: {
    lead: `${layouts.renderedPages} rendered pages produced ${nf(blockCat.totalInstances)} block instances. Near-identical blocks are consolidated into ${blockCat.totalVariants} variants, comparing only blocks of the same base type.`,
    exact_title: 'Signature match', exact: 'Blocks with the same base type and normalized structural signature collapse into one variant immediately.',
    weighted_title: 'Representative selection', weighted_lead: 'For each variant, the instance with the richest content becomes the representative shown in the gallery, and its page URL is recorded as the source.',
    weights: [
      { characteristic: 'base type', weight: '—', when: 'only blocks of the same type are compared' },
      { characteristic: 'tag + children', weight: '—', when: 'same wrapper tag and child-tag histogram' },
      { characteristic: 'feature flags', weight: '—', when: 'same img/table/list/form/iframe presence' },
      { characteristic: 'link bucket', weight: '—', when: 'same bucketed link count' },
      { characteristic: 'image bucket', weight: '—', when: 'same bucketed image count' },
    ],
    idnote: 'Variant IDs combine the base type, a label from the block’s heading, and its instance count — the labels used throughout the Blocks galleries.',
  },
  template_discovery: {
    lead: 'Separately, whole pages are fingerprinted and clustered into layout families with structure-based names; family page-counts are extrapolated to the full population via URL-pattern membership.',
    example: `${nf(livePages)} live pages consolidated into ${families.length} layout families — the largest, ${topFam[0].name}, covers ~${topFam[0].estPop} pages. A migration builds ~${families.length} templates, not thousands of bespoke pages.`,
  },
  integration_scan: {
    lead: 'The delivered HTML of every rendered page is scanned for third-party service signatures (script/iframe hosts, JS globals), aggregated site-wide and per layout family.',
    example: `${layouts.renderedPages} pages scanned. Google Tag Manager, OneTrust/Cookiebot consent and Google Analytics are near-universal; a dataLayer global appears on the majority of pages.`,
  },
  examples_intro: 'The two diagrams below trace two real blocks through the whole process. Read each top-to-bottom: the block screenshot, the five type-detection tiers (green = matched, grey = skipped), the measured fingerprint, then the final result. Example A is recognised as a standard type; Example B is not, and becomes an "unknown / custom" block.',
  examples: [
    { title: 'Example A — a block that IS a standard type (Cards)', img: 'cards-diagram.jpg', desc: 'A grid of linked promo tiles (group companies). Its container’s class contains "grid / card / link" and it holds several images and links.', reading: 'Matched at Tier 1 (class keyword) → base type cards → measured img + list + heading + links → catalogued as a cards variant with its source URL. Recognised automatically.' },
    { title: 'Example B — a block that is NOT a standard type (Unknown)', img: 'unknown-diagram.jpg', desc: 'A composite section — an image banner with a heading and supporting elements. Its container carries no standard class keyword and is not a table/form/iframe.', reading: 'No match at Tiers 1–4 → folded into the unknown / custom group → still measured and screenshotted. "Unknown" means "no automatic signal", not "unusable"; these blocks warrant a human review before build.' },
  ],
  key_contrast: 'High-volume templated pages (news / IR archives) and distinctive long-tail pages (governance, business landing, contact forms) are handled by different migration tracks — bulk import versus bespoke build.',
  how_to_read: [
    { section: 'Overview', shows: 'Headline counts (pages, families, block variants, integrations).' },
    { section: 'Page Templates', shows: 'The layout families, page-population estimates, key blocks and a full-page screenshot per family.' },
    { section: 'Blocks & Components', shows: 'Block variants grouped by base type, each with a cropped screenshot and source URL.' },
    { section: 'URL Coverage', shows: 'The complete crawl inventory grouped by locale, plus status counts.' },
    { section: 'Integrations', shows: 'Third-party services site-wide and per layout family.' },
  ],
  limitations: [
    'Heuristic, not authoritative. Block typing keys off DOM signals; the "text" base over-splits and absorbs anything without a distinctive signal.',
    'Layout counts are extrapolated. Family page-populations are estimated from URL-pattern sampling, not a full render of all pages.',
    'Screenshots are representative. Each variant’s image comes from one representative instance at crawl time.',
    'Documents are assets, not pages. The ~2,650 PDFs are inventoried but not rendered.',
  ],
  bottom_line: `${SITE_LABEL} reduces to ${families.length} layout families and ${blockCat.totalVariants} block variants — a tractable set to scope an EDS migration despite ${nf(livePages)} live pages. The "text" catch-all and any unusual assignments warrant a human review before build estimates are finalised.`,
};
const METHOD_IMAGES = {
  'cards-diagram.jpg': b64('shots', 'cards-diagram.jpg'),
  'unknown-diagram.jpg': b64('shots', 'unknown-diagram.jpg'),
};

// ---------- AEM tag-pattern overlay (optional; from consolidate-aem-components.js) ----------
const AEM = fs.existsSync(path.join(CF, 'aem-block-inventory.json'))
  ? require('./aem-overlay.js').apply({ DATA, METHOD, METHOD_IMAGES, IMAGES, CF, CFG, b64, SITE_ORIGIN, nf })
  : null;

// ---------- inject into cloned template ----------
let html = fs.readFileSync(TEMPLATE, 'utf8');
function replaceObj(name, obj) {
  const re = new RegExp('const ' + name + ' = \\{[\\s\\S]*?\\};\\n');
  const json = JSON.stringify(obj).split('<').join('\\u003c');
  if (!re.test(html)) throw new Error('marker not found: ' + name);
  html = html.replace(re, 'const ' + name + ' = ' + json + ';\n');
}
replaceObj('DATA', DATA);
replaceObj('IMAGES', IMAGES);
replaceObj('METHOD', METHOD);
replaceObj('METHOD_IMAGES', METHOD_IMAGES);
replaceObj('TEMPLATE_SHOTS', TEMPLATE_SHOTS);
if (AEM) AEM.patch(html, must);
// ---------- Probable backend integrations (optional; from backend.json) ----------
const backend = fs.existsSync(path.join(CF, 'backend.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'backend.json'))) : null;
if (backend && backend.services && backend.services.length) {
  const bjson = JSON.stringify(backend).split('<').join('\\u003c');
  // define a BACKEND global right after TEMPLATE_SHOTS
  html = html.replace(/const TEMPLATE_SHOTS = \{[\s\S]*?\};\n/, (mm) => mm + 'const BACKEND = ' + bjson + ';\n');
  // inject the section into the integrations renderer, right after the front-end integrations table closes
  const anchor = '   </table></div></div>\n   <div class="two-col" style="margin-top:26px">\n     <div class="panel panel-pad">\n       <h4>Notes on key integrations</h4>';
  const section = '   </table></div></div>\n'
    + '   ${(typeof BACKEND!==\'undefined\'&&BACKEND.services&&BACKEND.services.length)?`\n'
    + '   <div class="block-title" style="margin-top:30px"><h3>Probable backend integrations</h3><span class="tag">inferred from API calls</span></div>\n'
    + '   <p class="section-lead">Beyond the front-end tags above, these services were inferred from the <b>XHR / fetch API calls</b> the pages make at runtime — the back-end systems the site actually talks to. Captured across a ${BACKEND.sampledPages}-page sample. <b>First-party</b> entries are the site owner\\u2019s own micro-services (telemetry, identity, consent, pricing) that a migration must re-point or preserve; the rest are third-party APIs. <span style="color:var(--muted)">Probable, not definitive — based on observed network traffic, not server access.</span></p>\n'
    + '   <div class="kpi-row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:6px 0 14px">\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #6b3fa0"><div style="font-size:26px;font-weight:700;color:#6b3fa0">${BACKEND.totalServices}</div><div class="cap">Backend services<br>inferred from API traffic</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #1a7f4b"><div style="font-size:26px;font-weight:700;color:#1a7f4b">${BACKEND.services.filter(s=>/^First-party/.test(s.category)).length}</div><div class="cap">First-party<br>micro-services</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #b06d00"><div style="font-size:26px;font-weight:700;color:#b06d00">${BACKEND.categories.length}</div><div class="cap">distinct service<br>categories</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #8a8f98"><div style="font-size:26px;font-weight:700;color:#8a8f98">${(BACKEND.otherHosts||[]).length}</div><div class="cap">other API hosts<br>(unclassified)</div></div>\n'
    + '   </div>\n'
    + '   <div class="tbl-wrap"><div class="tbl-scroll"><table class="data">\n'
    + '     <thead><tr><th>Backend service</th><th>Category</th><th>Hosts</th><th class="num">Pages</th><th style="width:160px">Coverage</th></tr></thead>\n'
    + '     <tbody>${BACKEND.services.map(s=>{const pct=parseInt(s.coverage)||0;const fp=/^First-party/.test(s.category);const bcol=fp?\'#1a7f4b\':\'#6b3fa0\';\n'
    + '       return `<tr${fp?\' style="background:#eef7f1"\':\'\'}><td class="name-cell" style="font-size:13px" title="${esc((s.endpoints||[]).join(\' | \'))}">${esc(s.name)}</td>\n'
    + '        <td class="desc-cell"><span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:600;color:#fff;background:${bcol}">${esc(s.category)}</span></td>\n'
    + '        <td class="desc-cell mono" style="font-size:11px">${esc((s.hosts||[]).slice(0,2).join(\', \'))}${s.hostCount>2?\' +\'+(s.hostCount-2):\'\'}</td>\n'
    + '        <td class="num">${esc(String(s.pages))}</td>\n'
    + '        <td><div style="display:flex;align-items:center;gap:10px"><div class="mini-bar" style="flex:1"><i style="width:${pct}%;background:${bcol}"></i></div><span class="mono" style="font-size:11px;color:var(--muted);width:38px;text-align:right">${esc(s.coverage)}</span></div></td></tr>`;}).join(\'\')}</tbody>\n'
    + '   </table></div></div>\n'
    + '   <div class="cap" style="margin-top:6px">Hover a service name to see sample endpoints.</div>\n'
    + '   `:\'\'}\n'
    + '   <div class="two-col" style="margin-top:26px">\n     <div class="panel panel-pad">\n       <h4>Notes on key integrations</h4>';
  must(anchor, section);
}
// ---------- URL-coverage: Selected vs Skipped grouped view (optional; from inspection.json) ----------
const inspection = fs.existsSync(path.join(CF, 'inspection.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'inspection.json'))) : null;
if (inspection && inspection.rows && inspection.rows.length) {
  const ijson = JSON.stringify(inspection).split('<').join('\\u003c');
  html = html.replace(/const TEMPLATE_SHOTS = \{[\s\S]*?\};\n/, (mm) => mm + 'const INSPECTION = ' + ijson + ';\n');
  const covAnchor = 'renderers.coverage=()=>{\n  const v=$(\'#view-coverage\');\n  v.innerHTML=`\n   <p class="section-lead">${esc(DATA.coverage_lead||\'\')}</p>\n   <div class="two-col">';
  const covHead = 'renderers.coverage=()=>{\n  const v=$(\'#view-coverage\');\n  const S=INSPECTION.selInspect;\n  const inspRows=INSPECTION.rows.slice().sort((a,b)=>b.total-a.total);\n  v.innerHTML=`\n   <p class="section-lead">${esc(DATA.coverage_lead||\'\')}</p>\n'
    + '   <div class="block-title"><h3>What was inspected vs. skipped — by URL pattern</h3><span class="tag">render-set scope</span></div>\n'
    + '   <p class="section-lead" style="margin-top:2px">Every URL is grouped by its <b>semantic template</b> (locale-aware, section-vs-slug, depth-aware — e.g. <code>/{locale}/{section}/{page}</code>, <code>/r/{topic}/{article}</code>), then each template group is colour-coded by coverage. <b style="color:#1a7f4b">Fully inspected</b> — every page in the group rendered. <b style="color:#b06d00">Sampled</b> — a recurring shape where a representative subset was rendered. <b style="color:#8a8f98">Excluded</b> — none rendered (out of scope). Because grouping is by <em>shape</em>, any page whose structure is unique at the lowest level is its own group and is always rendered in full — never sampled out.</p>\n'
    + '   <div class="kpi-row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0 6px">\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #1a7f4b"><div style="font-size:26px;font-weight:700;color:#1a7f4b">${S.nonRrendered}<span style="font-size:15px;color:#8a8f98">/${S.nonRtotal}</span></div><div class="cap"><b style="color:#1a7f4b">FULLY INSPECTED</b><br>${S.fullGroups} template groups</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #d99a1c"><div style="font-size:26px;font-weight:700;color:#b06d00">${S.rRendered}<span style="font-size:15px;color:#8a8f98">/${S.rTotal}</span></div><div class="cap"><b style="color:#b06d00">SAMPLED</b><br>${S.rGroups} template groups</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #b8bcc4"><div style="font-size:26px;font-weight:700;color:#8a8f98">0<span style="font-size:15px;color:#8a8f98">/${S.exclTotal}</span></div><div class="cap"><b style="color:#8a8f98">EXCLUDED</b><br>${S.exclGroups} template groups</div></div>\n'
    + '     <div class="panel panel-pad" style="text-align:center;border-left:5px solid #2d6cdf"><div style="font-size:26px;font-weight:700;color:#2d6cdf">${S.selectedTotal}</div><div class="cap">TOTAL pages<br>inspected</div></div>\n'
    + '   </div>\n'
    + '   <div class="panel panel-pad">\n'
    + '     <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h4 style="margin:0">All URL templates — grouped &amp; colour-coded</h4>\n'
    + '       <div id="insp-filters" style="display:flex;gap:6px;font-size:12px"><button class="insp-fb" data-cat="all" style="cursor:pointer;border:1px solid #ccc;border-radius:6px;padding:3px 10px;background:#2d6cdf;color:#fff">All</button><button class="insp-fb" data-cat="full" style="cursor:pointer;border:1px solid #ccc;border-radius:6px;padding:3px 10px;background:#fff">Fully inspected</button><button class="insp-fb" data-cat="sampled" style="cursor:pointer;border:1px solid #ccc;border-radius:6px;padding:3px 10px;background:#fff">Sampled</button><button class="insp-fb" data-cat="excluded" style="cursor:pointer;border:1px solid #ccc;border-radius:6px;padding:3px 10px;background:#fff">Excluded</button></div>\n'
    + '     </div>\n'
    + '     <div class="cap" style="margin-top:4px">Row colour = category. Bar = % of that pattern\\u2019s pages rendered. ${inspRows.length} patterns.</div>\n'
    + '     <div class="toolbar" style="margin:8px 0"><label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="insp-search" placeholder="Filter templates / labels…"></label><span class="count-note" id="insp-count"></span></div>\n'
    + '     <div style="max-height:420px;overflow-y:auto"><table class="stat-list" id="insp-table" style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">ID</th><th style="text-align:left">Pattern group</th><th style="text-align:left">URL template</th><th>Group</th><th>URLs</th><th style="color:#1a7f4b">Rendered</th><th style="color:#a15c00">Skipped</th><th title="non-200 URLs in this group">4xx/5xx</th><th style="width:100px">Coverage</th></tr></thead><tbody id="insp-body"></tbody></table></div>\n'
    + '   </div>\n'
    + '   <div class="two-col">';
  must(covAnchor, covHead);
  // wire up the table + filters after the existing url-search listener
  const covJsAnchor = "  draw('');\n  $('#url-search').addEventListener('input',e=>draw(e.target.value.trim().toLowerCase()));\n};";
  const covJs = "  draw('');\n  $('#url-search').addEventListener('input',e=>draw(e.target.value.trim().toLowerCase()));\n"
    + "  const inspBody=$('#insp-body');\n"
    + "  const CAT={full:{row:'#e9f7ef',bar:'#1a7f4b',badge:'#1a7f4b',label:'Fully inspected'},sampled:{row:'#fdf5e6',bar:'#d99a1c',badge:'#b06d00',label:'Sampled'},excluded:{row:'#f2f3f5',bar:'#b8bcc4',badge:'#8a8f98',label:'Excluded'}};\n"
    + "  let inspCat='all';\n"
    + "  const drawInsp=q=>{\n"
    + "    const rows=inspRows.filter(r=>(inspCat==='all'||r.category===inspCat)&&(!q||(r.template+' '+(r.label||'')).toLowerCase().includes(q)));\n"
    + "    inspBody.innerHTML=rows.map(r=>{const pct=r.total?Math.round(r.selected/r.total*100):0;const c=CAT[r.category]||CAT.full;\n"
    + "      return `<tr style=\"background:${c.row}\"><td class=\"mono\" style=\"font-size:10.5px;color:var(--muted)\">${esc(r.groupId||'')}</td><td style=\"text-align:left;font-size:11.5px\">${esc(r.label||'')}</td><td class=\"mono\" style=\"text-align:left;font-size:11px\">${esc(r.template)}</td><td><span style=\"display:inline-block;padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:600;color:#fff;background:${c.badge}\">${c.label}</span></td><td>${r.total}</td><td style=\"color:#1a7f4b;font-weight:600\">${r.selected}</td><td style=\"color:${r.skipped?'#a15c00':'#8a8f98'}\">${r.skipped}</td><td style=\"color:${r.non200?'#a15c00':'#8a8f98'}\">${r.non200||0}</td><td><div style=\"background:#e3e5e8;border-radius:4px;height:8px;overflow:hidden\" title=\"${pct}%\"><div style=\"background:${c.bar};height:100%;width:${pct}%\"></div></div></td></tr>`;}).join('');\n"
    + "    $('#insp-count').textContent=rows.length+' template groups'+(inspCat!=='all'?' ('+CAT[inspCat].label+')':'');\n"
    + "  };\n"
    + "  drawInsp('');\n"
    + "  $('#insp-search').addEventListener('input',e=>drawInsp(e.target.value.trim().toLowerCase()));\n"
    + "  document.querySelectorAll('.insp-fb').forEach(btn=>btn.addEventListener('click',()=>{inspCat=btn.dataset.cat;document.querySelectorAll('.insp-fb').forEach(b=>{b.style.background='#fff';b.style.color='#000';});btn.style.background='#2d6cdf';btn.style.color='#fff';drawInsp(($('#insp-search').value||'').trim().toLowerCase());}));\n"
    + "};";
  must(covJsAnchor, covJs);
}
// retitle (from config)
const BRAND = CFG.brandLine || ((CFG.site || 'Site') + '<br>Migration Console');
html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${CFG.site || 'Site'} — Site Analysis</title>`);
html = html.replace(/Saran Section<br>Migration Console/g, BRAND);
html = html.replace(/Saran Site Analysis/g, `${CFG.site || 'Site'} Site Analysis`);

// ---------- Human-in-the-loop Review: retarget the template's Saran defaults ----------
function must(find, repl) { if (html.indexOf(find) < 0) throw new Error('marker not found: ' + find.slice(0, 60)); html = html.split(find).join(repl); }

// 1) Namespace localStorage keys per-site so a browser that opened another dashboard
//    (e.g. the Saran template) does NOT load its cached review/title/nav state here.
html = html.replace(/'saran-dash-nav-collapsed'/g, `'${NS}-dash-nav-collapsed'`);
html = html.replace(/'saran-dash-title'/g, `'${NS}-dash-title'`);
html = html.replace(/'saran-dash-eyebrow'/g, `'${NS}-dash-eyebrow'`);
html = html.replace(/'saran-hilr-review-v1'/g, `'${NS}-hilr-review-v1'`);

// 2) Family maps: extend to Marubeni gallery names (Media, Embed, List, Text, Unknown / Custom …)
const famBase = families; // not used; galleries drive review
const MB_TYPE = "{Cards:'Core',Media:'Core',Table:'Core',Form:'Core',Embed:'Core',Breadcrumbs:'Core',Hero:'Core',List:'Core',Text:'Core','Unknown / Custom':'Custom'}";
const MB_CX = "{Cards:'Medium',Media:'Simple',Table:'Medium',Form:'Complex',Embed:'Medium',Breadcrumbs:'Simple',Hero:'Medium',List:'Simple',Text:'Simple','Unknown / Custom':'Complex'}";
const MB_CORE = "{Cards:'Cards',Media:'Media / Image',Table:'Table',Form:'Form',Embed:'Embed / iframe',Breadcrumbs:'Breadcrumbs',Hero:'Hero',List:'Cards / List',Text:'Text',_x:''}";
const MB_TYPEKEY = "{Cards:'cards',Media:'media',Table:'table',Form:'form',Embed:'iframe-embed',Breadcrumbs:'breadcrumbs',Hero:'hero',List:'list',Text:'text','Unknown / Custom':'unknown'}";
html = html.replace(/var FAMILY_TYPE=\{[^}]*\};/, 'var FAMILY_TYPE=' + MB_TYPE + ';');
html = html.replace(/var FAMILY_CX=\{[^}]*\};/, 'var FAMILY_CX=' + MB_CX + ';');
html = html.replace(/var FAMILY_CORE=\{[^}]*\};/, 'var FAMILY_CORE=' + MB_CORE + ';');
html = html.replace(/var FAMILY_TYPEKEY=\{[^}]*\};/, 'var FAMILY_TYPEKEY=' + MB_TYPEKEY + ';');

// 3) Engagement seed + remarks (from config)
must("accountName:'Asahi Kasei — Saran'", `accountName:'${(CFG.accountName || CFG.site || '').replace(/'/g, "")}'`);
must("Pre-seeded from the automated site analysis of the /saran/ hierarchy (", `Pre-seeded from the automated site analysis of ${CFG.site || 'the site'} (`);

// 4) Header lead: "13 base block families" -> actual count
const famCount = DATA.galleries.length;
html = html.replace(/pre-seeded from the analysis \(13 base block families,/i,
  `pre-seeded from the analysis (${famCount} base block families,`);

// 5) Download filename
html = html.replace(/'saran-block-review'/g, `'${NS}-block-review'`);

// 6) CRITICAL: the global SITE constant used by abs() to resolve every relative
//    source URL (Page Templates, Blocks, Review) — retarget to this site's origin.
must("const SITE='https://www.asahi-kasei.co.jp';", `const SITE='${SITE_ORIGIN}';`);

// 7) Block-level integration heatmap — add a second heatmap under the per-template one.
//    Insert the extra markup into the integrations renderer template string.
must(
  '   <div class="heat-toggle"><button class="active" data-mode="pct">Percent</button><button data-mode="counts">Counts</button></div>\n   <div class="heat-wrap" id="heat-mount"></div>`;',
  '   <div class="heat-toggle"><button class="active" data-mode="pct">Percent</button><button data-mode="counts">Counts</button></div>\n'
  + '   <div class="heat-wrap" id="heat-mount"></div>'
  + '${DATA.block_heatmap_pct?`'
  + '<div class="block-title"><h3>Per-block-type coverage heatmap</h3><span class="tag">integration adoption by base block type</span></div>'
  + '<p class="section-lead" style="margin-bottom:14px">For each base block type, the share of pages containing that block that also carry each integration. Reveals which integrations travel with which components — e.g. Embed blocks pull in Maps/YouTube, Forms always sit with analytics &amp; consent.</p>'
  + '<div class="heat-toggle" id="bheat-toggle"><button class="active" data-mode="pct">Percent</button><button data-mode="counts">Counts</button></div>'
  + '<div class="heat-wrap" id="bheat-mount"></div>`:\'\'}`;'
);
// wire up drawing + toggle after drawHeat('pct'); in the renderer.
// Scope each toggle's buttons to its own container so the two heatmaps are independent.
must(
  "  drawHeat('pct');\n  $$('.heat-toggle button').forEach(b=>b.onclick=()=>{$$('.heat-toggle button').forEach(x=>x.classList.remove('active'));b.classList.add('active');drawHeat(b.dataset.mode);});",
  "  drawHeat('pct');\n"
  + "  const _tmplTg=$('#view-integrations .heat-toggle');\n"
  + "  if(_tmplTg)$$('button',_tmplTg).forEach(b=>b.onclick=()=>{$$('button',_tmplTg).forEach(x=>x.classList.remove('active'));b.classList.add('active');drawHeat(b.dataset.mode);});\n"
  + "  if(DATA.block_heatmap_pct){drawBlockHeat('pct');const _bt=$('#bheat-toggle');if(_bt)$$('button',_bt).forEach(b=>b.onclick=()=>{$$('button',_bt).forEach(x=>x.classList.remove('active'));b.classList.add('active');drawBlockHeat(b.dataset.mode);});}"
);
// add drawBlockHeat function right after drawHeat's definition (reuse heatColor)
must(
  'function drawHeat(mode){',
  'function drawBlockHeat(mode){\n'
  + '  const h=DATA.block_heatmap_pct, hc=DATA.block_heatmap_counts; if(!h)return;\n'
  + '  const cols=h.integrations; const rows=mode===\'pct\'?h.rows:hc.rows;\n'
  + '  let html=\'<table class="heat"><thead><tr><th class="tmpl">Block type</th><th>Pg</th>\'+cols.map(c=>`<th>${esc(c)}</th>`).join(\'\')+\'</tr></thead><tbody>\';\n'
  + '  rows.forEach((r,ri)=>{\n'
  + '    html+=`<tr><td class="tmpl">${esc(r.template)}</td><td class="pg">${esc(r.pg)}</td>`;\n'
  + '    r.cells.forEach((cell,ci)=>{\n'
  + '      const pctCell=DATA.block_heatmap_pct.rows[ri].cells[ci];\n'
  + '      let pct=0;const mm=(pctCell||\'\').match(/(\\d+)/);if(mm)pct=+mm[1];\n'
  + '      const isDot=(cell===\'·\'||cell===\'\'||cell==null);\n'
  + '      const {bg,fg}=heatColor(pct);\n'
  + '      html+=`<td><div class="cell-v" style="background:${isDot?\'transparent\':bg};color:${isDot?\'var(--faint)\':fg}">${isDot?\'·\':esc(cell)}</div></td>`;\n'
  + '    });\n'
  + '    html+=\'</tr>\';\n'
  + '  });\n'
  + '  html+=\'</tbody></table>\';\n'
  + '  $(\'#bheat-mount\').innerHTML=html;\n'
  + '}\n'
  + 'function drawHeat(mode){'
);

const OUT = CFG.outFile || path.join(REPORTS, `${NS}-site-analysis-dashboard.html`);
fs.writeFileSync(OUT, html);
console.log('written:', OUT, (fs.statSync(OUT).size / 1048576).toFixed(2) + ' MB');
console.log('templates:', templates.length, 'galleries:', galleries.map((g) => g.name + ':' + g.variants.length).join(', '));
console.log('IMAGES:', Object.keys(IMAGES).length, 'TEMPLATE_SHOTS:', Object.keys(TEMPLATE_SHOTS).length);
