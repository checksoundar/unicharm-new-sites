#!/usr/bin/env node
// Generates config.json for each Fonterra-group site analysed with the site-analysis-dashboard skill.
const fs = require('fs');
const path = require('path');
const ROOT = '/backups/checksoundar/unicharm-new-sites/repo';
const SKILL = `${ROOT}/.claude/skills/site-analysis-dashboard`;
const single = (label) => [{ key: 'site', label, prefix: '/' }];
const SITES = [
  { dir: 'nzfarmsource-co-nz-scope', site: 'nzfarmsource.co.nz', origin: 'https://nzfarmsource.co.nz', url: 'https://nzfarmsource.co.nz/', brand: 'NZ Farm Source', locale: 'en-NZ (single)',
    crawl: { sitemaps: ['https://nzfarmsource.co.nz/sitemap.xml'], concurrency: 6 }, properties: single('Farm Source') },
  { dir: 'fonterra-com-scope', site: 'fonterra.com', origin: 'https://www.fonterra.com', url: 'https://www.fonterra.com/nz/en.html', brand: 'Fonterra', locale: '10 regions / locales', multiLocale: true,
    crawl: { sitemaps: ['https://www.fonterra.com/sitemap.xml'], seeds: ['https://www.fonterra.com/nz/en.html'], concurrency: 8, delay: 100 },
    fullPrefixes: ['/nz/en'], renderSample: 4,
    scopeNote: 'nz/en rendered in full; the other 9 regions/locales rendered for every unique URL template with recurring templates sampled',
    properties: [
      { key: 'nz-en', label: 'NZ (en)', prefix: '/nz/en' }, { key: 'au-en', label: 'AU (en)', prefix: '/au/en' },
      { key: 'jp-ja', label: 'JP (ja)', prefix: '/jp/ja' }, { key: 'jp-en', label: 'JP (en)', prefix: '/jp/en' },
      { key: 'cn-zh', label: 'CN (zh)', prefix: '/cn/zh' }, { key: 'cn-en', label: 'CN (en)', prefix: '/cn/en' },
      { key: 'lk-en', label: 'LK (en)', prefix: '/lk/en' }, { key: 'eu-en', label: 'EU (en)', prefix: '/eu/en' },
      { key: 'sea', label: 'SEA', prefix: '/sea' }, { key: 'americas', label: 'Americas', prefix: '/americas' }], cjk: true },
  { dir: 'visit-fonterra-com-scope', site: 'visit.fonterra.com', origin: 'https://www.visit.fonterra.com', url: 'https://www.visit.fonterra.com/global/en/home.html', brand: 'Fonterra Virtual Visit', locale: 'en (single) — AEM SPA',
    crawl: { seeds: ['/global/en/home.html', '/global/en/home/on-farm.html', '/global/en/home/milk-collection.html', '/global/en/home/manufacturing.html', '/global/en/home/distribution.html', '/global/en/home/export.html'].map((p) => 'https://www.visit.fonterra.com' + p) },
    ignoreClasses: ['vv-component'], properties: single('Virtual Visit'), discovery: 'AEM SPA model.json (:children) — no sitemap, links are JS-driven' },
  { dir: 'kituafund-com-scope', site: 'kituafund.com', origin: 'https://www.kituafund.com', url: 'https://www.kituafund.com/global/en.html', brand: 'Kitua Fund', locale: 'en (single)',
    crawl: { sitemaps: ['https://www.kituafund.com/global/en/sitemap.xml'], seeds: ['https://www.kituafund.com/global/en.html'] }, properties: single('Kitua Fund') },
  { dir: 'nutiani-com-scope', site: 'nutiani.com', origin: 'https://www.nutiani.com', url: 'https://www.nutiani.com/nz/en.html', brand: 'Nutiani', locale: 'en-NZ (single)',
    crawl: { sitemaps: ['https://www.nutiani.com/sitemap.xml'], seeds: ['https://www.nutiani.com/nz/en.html'] }, properties: single('Nutiani') },
  { dir: 'nzagbiz-co-nz-scope', site: 'nzagbiz.co.nz', origin: 'https://www.nzagbiz.co.nz', url: 'https://www.nzagbiz.co.nz/nz/en.html', brand: 'NZAgbiz', locale: 'en-NZ (single)',
    crawl: { sitemaps: ['https://www.nzagbiz.co.nz/sitemap.xml'], seeds: ['https://www.nzagbiz.co.nz/nz/en.html'] }, properties: single('NZAgbiz') },
  { dir: 'nzmp-com-scope', site: 'nzmp.com', origin: 'https://www.nzmp.com', url: 'https://www.nzmp.com/global/en.html', brand: 'NZMP', locale: 'en (global)',
    crawl: { sitemaps: ['https://www.nzmp.com/sitemap.xml'], seeds: ['https://www.nzmp.com/global/en.html'], concurrency: 6 }, properties: single('NZMP') },
  { dir: 'proliq-nz-scope', site: 'proliq.nz', origin: 'https://proliq.nz', url: 'https://proliq.nz/nz/en.html', brand: 'Proliq', locale: 'en-NZ (single)',
    crawl: { sitemaps: ['https://proliq.nz/nz/en/sitemap.xml'], seeds: ['https://proliq.nz/nz/en.html'] }, properties: single('Proliq') },
  { dir: 'lactanol-com-scope', site: 'lactanol.com', origin: 'https://www.lactanol.com', url: 'https://www.lactanol.com/', brand: 'Lactanol', locale: 'en (single) — one-page site',
    crawl: { seeds: ['https://www.lactanol.com/'] }, componentSelector: 'section.nav, section.page-section, .comp__footer',
    properties: single('Lactanol'), discovery: 'single-page site (in-page #anchor navigation) — legacy AEM foundation parsys, no sitemap' },
];
for (const s of SITES) {
  const CF = path.join(ROOT, '.migration', s.dir);
  fs.mkdirSync(CF, { recursive: true });
  const prev = fs.existsSync(path.join(CF, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')) : {};
  const cfg = {
    siteUrl: s.url, siteOrigin: s.origin, site: s.site,
    scope: s.scopeNote ? `Entire domain — ${s.scopeNote}` : 'Entire domain — every page rendered (no sampling)',
    eyebrow: `${s.brand} (Fonterra) · Site Analysis`, heroTitle: `Structural analysis of ${s.site}`, heroSub: '',
    brandLine: `${s.site}<br>Migration Console`, accountName: `Fonterra — ${s.brand}`, locale: s.locale, multiLocale: !!s.multiLocale,
    discovery: s.discovery || 'sitemap + scoped link crawl', cjk: !!s.cjk,
    catalogFolder: CF, reportsDir: `${ROOT}/reports`, templateHtml: `${SKILL}/templates/dashboard-template.html`, outFile: '',
    blockStrategy: 'aem', sharedMapping: `${ROOT}/.migration/fonterra-shared-block-mapping.json`,
    crawl: s.crawl, properties: s.properties,
  };
  for (const k of ['fullPrefixes', 'renderSample', 'componentSelector', 'ignoreClasses']) if (s[k]) cfg[k] = s[k];
  if (prev.familyDescriptions) cfg.familyDescriptions = prev.familyDescriptions;
  fs.writeFileSync(path.join(CF, 'config.json'), JSON.stringify(cfg, null, 2));
  console.log(CF);
}
