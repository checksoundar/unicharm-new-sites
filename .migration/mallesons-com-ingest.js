#!/usr/bin/env node
/*
 * mallesons-com-ingest.js — build the mallesons.com catalog from MANUAL LIVE CAPTURES
 * (the live site is behind a Cloudflare managed challenge, so pages were captured by hand in a real
 * browser: rendered-DOM HTML + full-page desktop/mobile screenshots per URL of the agreed sample).
 *
 *  1. index manual/<locale>/<group>/*.rendered.html → canonical URL (from <link rel=canonical>/og:url)
 *  2. localise each page into manual/_local/: scripts made inert (src kept for integration detection),
 *     <base href> = the page's live URL so relative links/assets resolve to www.mallesons.com
 *     (fetched via the Wayback Machine at render time — config.assetSource = "wayback")
 *  3. fetch-map.json  live URL → file:// localised copy
 *  4. .crawl.out / urls-all / groups / render-set from the sample (template_group from sample.csv)
 *  5. captures.json   live URL → { desktop, mobile } screenshot paths (for template previews)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = '/backups/checksoundar/unicharm-new-sites/repo';
const SKILL = `${ROOT}/.claude/skills/site-analysis-dashboard`;
const CF = `${ROOT}/.migration/mallesons-com-scope`;
const MAN = `${CF}/manual`;
const LOCAL = `${MAN}/_local`;
const ORIGIN = 'https://www.mallesons.com';
const SAMPLE_CSV = '/backups/checksoundar/unicharm-new-sites/sites/checksoundar~unicharm-new-sites/chat/attachments/muz7h0uh-c0y7s8/0-sample.csv';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '_local' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const csv = fs.readFileSync(SAMPLE_CSV, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((l) => { const [locale, group, url] = l.split(','); return { locale, group, url: url.trim() }; });
const byUrl = Object.fromEntries(csv.map((r) => [r.url, r]));

fs.mkdirSync(LOCAL, { recursive: true });
const files = walk(MAN);
const pages = {};
const problems = [];
const findings = [];
const exactStems = new Set(files.filter((x) => x.endsWith('.html')).map((x) => path.basename(x).replace(/\.rendered\.html$/, '').replace(/\.html$/, '')));
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const h = fs.readFileSync(f, 'utf8');
  const canon = (/<link rel="canonical" href="([^"]+)"/i.exec(h) || /<meta property="og:url" content="([^"]+)"/i.exec(h) || [])[1];
  if (!canon) { problems.push(`no canonical: ${path.relative(MAN, f)}`); continue; }
  let url = canon.replace(/^http:/, 'https:').replace(/^https:\/\/mallesons\.com/, ORIGIN);
  const stem = f.replace(/\.rendered\.html$/, '').replace(/\.html$/, '');
  const shot = (k) => [`${stem}__${k}.png`, `${stem}_${k}.png`].find((p) => fs.existsSync(p)) || '';
  // localise: freeze the captured DOM (inert scripts), resolve relative URLs against the live page
  let l = h.replace(/<script\b(?![^>]*application\/ld\+json)([^>]*)>/gi, (m, a) => `<script type="text/x-inert"${a.replace(/\stype="[^"]*"/i, '')}>`);
  l = l.replace(/<base\b[^>]*>/gi, '').replace(/<head([^>]*)>/i, `<head$1><base href="${url}">`);
  const lf = path.join(LOCAL, path.relative(MAN, f));
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, l);
  // identity = the SAMPLE row the file was captured for (filename = URL path with '/'→'_', possibly
  // truncated); the canonical is kept to flag redirects / duplicate paths as findings
  const fstem = path.basename(stem);
  const keyOf = (r) => r.url.replace(ORIGIN + '/', '').replace(/\.html$/, '').replace(/\//g, '_');
  // exact filename match first; truncated names (long URLs) fall back to a prefix match against rows
  // whose exact-named file does not exist (so parent pages never claim their children's rows)
  const row = csv.find((r) => keyOf(r) === fstem) || csv.find((r) => fstem.length >= 40 && keyOf(r).startsWith(fstem) && !exactStems.has(keyOf(r)));
  if (/sitemap/i.test(fstem)) { problems.push(`sitemap page (XML) excluded from analysis: ${path.relative(MAN, f)}`); continue; }
  if (!row) { problems.push(`no sample row for ${path.relative(MAN, f)}`); continue; }
  const sampleUrl = row.url;
  if (sampleUrl !== url) findings.push({ sampleUrl, canonical: url, kind: /latest-thinking\.html$/.test(url) ? 'article removed → falls back to listing' : 'canonical differs (alias / duplicate path)' });
  url = sampleUrl;
  if (pages[url]) problems.push(`duplicate capture for ${url}: ${path.relative(MAN, f)}`);
  pages[url] = { url, html: path.relative(CF, f), local: lf, desktop: shot('desktop') ? path.relative(CF, shot('desktop')) : '', mobile: shot('mobile') ? path.relative(CF, shot('mobile')) : '', inSample: !!byUrl[url], group: (byUrl[url] || {}).group || '', locale: (byUrl[url] || {}).locale || '' };
}
const missingCapture = csv.filter((r) => !pages[r.url]).map((r) => r.url);
const notInSample = Object.values(pages).filter((p) => !p.inSample).map((p) => p.url);
const missingShots = Object.values(pages).filter((p) => !p.desktop || !p.mobile).map((p) => `${p.url.replace(ORIGIN, '')} (${!p.desktop ? 'desktop ' : ''}${!p.mobile ? 'mobile' : ''})`);

fs.writeFileSync(path.join(CF, 'captures.json'), JSON.stringify(pages, null, 1));
fs.writeFileSync(path.join(CF, 'fetch-map.json'), JSON.stringify(Object.fromEntries(Object.values(pages).map((p) => [p.url, 'file://' + p.local])), null, 1));
// inventory = live AU XML sitemap (captured in the browser) ∪ every sample URL; redirect/alias rows flagged 301
const smFile = path.join(CF, 'sitemap-urls.json');
const sitemap = fs.existsSync(smFile) ? JSON.parse(fs.readFileSync(smFile, 'utf8')) : [];
const inv = new Map(sitemap.map((u) => [u, { url: u, status: 200, from: 'sitemap-au (manual capture)' }]));
for (const r of csv) if (!inv.has(r.url)) inv.set(r.url, { url: r.url, status: 200, from: 'sample' });
for (const fd of findings) if (/removed/.test(fd.kind)) inv.set(fd.sampleUrl, { url: fd.sampleUrl, status: 301, finalUrl: fd.canonical, from: 'sample' });
for (const r of csv) if (/sitemap\/sitemap-/.test(r.url)) inv.delete(r.url);
fs.writeFileSync(path.join(CF, '.crawl.out'), JSON.stringify([...inv.values()], null, 1));
fs.writeFileSync(path.join(CF, 'capture-findings.json'), JSON.stringify({ findings, problems }, null, 1));

const cfg = {
  siteUrl: ORIGIN + '/au/en/home.html', siteOrigin: ORIGIN, site: 'mallesons.com',
  scope: `Sample analysis of ${Object.keys(pages).length} live pages across ${new Set(csv.map((r) => r.locale + '|' + r.group)).size} template groups (AU + SG) — manually captured in a real browser (live site is Cloudflare-protected)`,
  eyebrow: 'Mallesons (formerly KWM) · Site Analysis', heroTitle: 'Structural analysis of mallesons.com — live-capture sample (AU + SG)',
  heroSub: 'The live site sits behind a Cloudflare bot challenge, so pages were captured manually in a real browser: the rendered DOM of each page plus full-page desktop and mobile screenshots. The rendered DOM was analysed with the AEM component tag-pattern pipeline (block crops re-rendered locally with the site stylesheets served from the Internet Archive); page-template previews use the original desktop/mobile captures.',
  brandLine: 'mallesons.com<br>Migration Console', accountName: 'Mallesons (formerly King & Wood Mallesons)', locale: 'en-AU + en-SG', multiLocale: true,
  discovery: 'agreed sample list (295 URLs, 44 template groups) — manual live captures; live sitemaps blocked by Cloudflare', cjk: false,
  catalogFolder: CF, reportsDir: `${ROOT}/reports`, templateHtml: `${SKILL}/templates/dashboard-template.html`, outFile: '',
  blockStrategy: 'aem', assetSource: 'wayback', source: 'manual-capture',
  hideSelectors: ['[id^="_hj"]', '[class*="_hj-"]', '.hotjar', '#hotjar-survey'],
  properties: [{ key: 'au-en', label: 'AU (en)', prefix: '/au/en' }, { key: 'sg-en', label: 'SG (en)', prefix: '/sg/en' }],
};
const prev = fs.existsSync(path.join(CF, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')) : {};
if (prev.familyDescriptions) cfg.familyDescriptions = prev.familyDescriptions;
fs.writeFileSync(path.join(CF, 'config.json'), JSON.stringify(cfg, null, 2));

execFileSync('node', [`${SKILL}/scripts/build-urls-all.js`, CF], { stdio: 'inherit' });
fs.rmSync(path.join(CF, 'render-set.json'), { force: true });
execFileSync('node', [`${SKILL}/scripts/build-render-set.js`, CF, '2', '100000'], { stdio: ['ignore', 'ignore', 'inherit'] });

{
  const urls = Object.keys(pages).filter((u) => !findings.some((fd) => fd.sampleUrl === u && /removed/.test(fd.kind))).sort();
  fs.writeFileSync(path.join(CF, 'render-set.json'), JSON.stringify({ captured: new Date().toISOString(), strategy: 'agreed sample (≤20 pages per template group, AU + SG) captured manually in a real browser', totalLivePages: inv.size, renderCount: urls.length, urls }, null, 1));
  const g = JSON.parse(fs.readFileSync(path.join(CF, 'groups.json'), 'utf8')); const set = new Set(urls);
  for (const [k, v] of Object.entries(g.groups)) if (g.groupMeta[k]) { g.groupMeta[k].rendered = v.filter((u) => set.has(u)).length; g.groupMeta[k].type = g.groupMeta[k].rendered < v.length ? 'pattern' : 'long-tail'; }
  fs.writeFileSync(path.join(CF, 'groups.json'), JSON.stringify(g, null, 1));
  console.log(`inventory ${inv.size} (sitemap ${sitemap.length}) | render set ${urls.length}`);
}
findings.forEach((fd) => console.log(`  finding: ${fd.sampleUrl.replace(ORIGIN, '')} → ${fd.kind} (${fd.canonical.replace(ORIGIN, '')})`));
console.log(`captured pages ${Object.keys(pages).length} | sample rows ${csv.length} | missing captures ${missingCapture.length} | captures outside sample ${notInSample.length}`);
if (missingCapture.length) console.log('  missing:', missingCapture.join('\n           '));
if (notInSample.length) console.log('  outside sample:', notInSample.join('\n                  '));
console.log(`missing screenshots: ${missingShots.length}`); missingShots.forEach((m) => console.log('  ' + m));
problems.forEach((p) => console.log('  ! ' + p));
