#!/usr/bin/env node
/*
 * compute-data.js — derive the supplementary datasets the dashboard needs from the
 * crawl + render + block artifacts:
 *   - urls-all.json      (built from the crawler output; see SKILL.md step 1)
 *   - pages.jsonl        (render-pages.js)
 *   - blocks.jsonl       (capture-blocks.js)
 *   - groups.json        (build-render-set.js)
 *   - layouts.json       (cluster-layouts.js)
 *
 * Produces: site-structure.json, documents.json, url-groups.json,
 *           heatmap.json (per-layout), block-heatmap.json (per-base-type).
 *
 * Usage: node compute-data.js <catalogFolder> [siteOrigin]
 *   siteOrigin defaults to the origin of the first crawled URL.
 */
const fs = require('fs');
const path = require('path');
const CF = process.argv[2] || '.';
const rd = (f) => JSON.parse(fs.readFileSync(path.join(CF, f), 'utf8'));
const rdl = (f) => fs.readFileSync(path.join(CF, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const all = rd('urls-all.json')['analysis-urls-all'];
const pages = rdl('pages.jsonl').filter((p) => p.status === 'ok');
const blocks = rdl('blocks.jsonl').filter((b) => b.captured);
const layouts = rd('layouts.json').templates;

// Scope prefix: the path portion of the configured siteUrl (e.g. "/int/en" or "/saran").
// Structure/URL groups are computed RELATIVE to this so a section-scoped analysis
// groups by its real sub-sections rather than collapsing to one prefix.
let SCOPE = ''; let SITE_ORIGIN_CFG = '';
try { const cfg = rd('config.json'); SCOPE = (cfg.siteUrl || '').replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''); SITE_ORIGIN_CFG = cfg.siteOrigin || ''; } catch (e) { /* none */ }
const rel = (pathOnly) => (SCOPE && pathOnly.startsWith(SCOPE) ? pathOnly.slice(SCOPE.length) : pathOnly);

// First-party domain matcher (site-agnostic) — derived from config.siteOrigin.
function registrable(h) { const p = (h || '').toLowerCase().split('.').filter(Boolean); return p.length <= 2 ? p.join('.') : p.slice(-2).join('.'); }
const FP_BASE = (() => { try { return registrable(new URL(SITE_ORIGIN_CFG).hostname); } catch (e) { return ''; } })();
const FP_BRAND = (() => { try { return new URL(SITE_ORIGIN_CFG).hostname.split('.')[0]; } catch (e) { return ''; } })();
function isFirstParty(h) { h = (h || '').toLowerCase(); if (FP_BASE && (h === FP_BASE || h.endsWith('.' + FP_BASE))) return true; if (FP_BRAND && FP_BRAND.length >= 4 && h.includes(FP_BRAND)) return true; return false; }

const norm = (u) => u.split(/[?#]/)[0].replace(/\/index\.html$/, '/');
const IMG = /\.(jpg|jpeg|png|gif|svg|webp|ico)$/i;
const live = [...new Set(all.urls.filter((x) => x.status === 200 && !IMG.test(norm(x.url))).map((x) => norm(x.url)))].sort();
const LOCALES = ['en', 'jp', 'ja', 'brasil', 'korea', 'philippines', 'tw', 'oceania', 'vietnam', 'gallery', 'zh', 'cn', 'de', 'fr', 'es', 'th', 'id'];

// --- site structure: group by the first 1-2 path segments BELOW the scope prefix, keep >=3 pages ---
const struct = {};
for (const u of live) { const rp = rel(u.replace(/^https?:\/\/[^/]+/, '')).split('/').filter(Boolean); const k = (SCOPE || '') + '/' + rp.slice(0, 2).join('/'); struct[k] = (struct[k] || 0) + 1; }
let siteStructure = Object.entries(struct).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).map(([p, v]) => ({ path: p, pages: String(v) }));
if (siteStructure.length < 2) { // fall back to deeper grouping if the 2-seg grouping collapsed
  const s2 = {}; for (const u of live) { const rp = rel(u.replace(/^https?:\/\/[^/]+/, '')).split('/').filter(Boolean); const k = (SCOPE || '') + '/' + rp.slice(0, 3).join('/'); s2[k] = (s2[k] || 0) + 1; }
  siteStructure = Object.entries(s2).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).map(([p, v]) => ({ path: p, pages: String(v) }));
}
fs.writeFileSync(path.join(CF, 'site-structure.json'), JSON.stringify(siteStructure));

// --- documents (200) ---
const docs = all.documents.filter((d) => d.status === 200).map((d) => d.url);
fs.writeFileSync(path.join(CF, 'documents.json'), JSON.stringify(docs));

// --- url groups by first segment BELOW the scope prefix (locale/section) ---
const loc = {};
for (const u of live) { const p = u.replace(/^https?:\/\/[^/]+/, ''); const seg = rel(p).split('/').filter(Boolean)[0] || '(root)'; const g = (SCOPE || '') + '/' + seg; (loc[g] = loc[g] || []).push(p); }
const urlGroups = Object.entries(loc).sort((a, b) => b[1].length - a[1].length).map(([group, urls]) => ({ group, count: urls.length, urls: urls.slice(0, 60) }));
fs.writeFileSync(path.join(CF, 'url-groups.json'), JSON.stringify(urlGroups));

// --- integration detectors (shared) — the ~13 most prevalent services become heatmap columns ---
const DET = [
  ['Tealium', /tiqcdn|tealium/], ['GTM', /googletagmanager/], ['GA', /google-analytics|analytics\.google/], ['Adobe', /adobe|omtrdc|demdex|2o7\.net/],
  ['Google Ads', /doubleclick|googleadservices|googlesyndication/], ['Meta', /facebook\.net|facebook\.com|fbcdn/], ['TikTok', /tiktok/],
  ['Bing', /bat\.bing|\bbing\.com/], ['Snapchat', /snap\.licdn|snapchat|sc-static/], ['Pinterest', /pinimg|pinterest/], ['LinkedIn', /licdn|linkedin\.com/],
  ['LivePerson', /liveperson|lpsnmedia|lptag|lpcdn/], ['Qualtrics', /qualtrics|siteintercept/], ['YouTube', /youtube|ytimg|youtu\.be/],
  ['Clarity', /clarity\.ms/], ['Adobe RUM', /rum\.hlx\.page|rum\.aem\.page/],
];
const INTG = DET.map((d) => d[0]);
const GLB = { GTM: 'google_tag_manager', GA: 'ga', Adobe: 'adobe', Meta: 'fbq', Tealium: 'utag' }; // global-object fallbacks
const pageIntg = {};
for (const p of pages) { const src = ((p.scripts || []).concat(p.iframeSrcs || [])).join(' ').toLowerCase(); const set = new Set(); DET.forEach((d, i) => { if (d[1].test(src) || (GLB[d[0]] && (p.globals || []).includes(GLB[d[0]]))) set.add(i); }); pageIntg[p.url] = set; }

// --- per-layout heatmap (cluster pages by fingerprint -> family name) ---
const sig2name = {}; for (const t of layouts) sig2name[t.signature] = t.name;
const famOf = {}; for (const p of pages) famOf[p.url] = sig2name[p.signature] || 'other';
const names = {};
for (const p of pages) { const n = famOf[p.url]; const o = names[n] = names[n] || { pg: 0, hit: INTG.map(() => 0) }; o.pg++; const s = pageIntg[p.url]; if (s) s.forEach((i) => o.hit[i]++); }
const hmRows = Object.entries(names).sort((a, b) => b[1].pg - a[1].pg).map(([template, o]) => ({ template, pg: String(o.pg), cellsPct: o.hit.map((h) => (h === 0 ? '·' : Math.round(h / o.pg * 100) + '%')), cellsCnt: o.hit.map((h) => (h === 0 ? '·' : h + '/' + o.pg)) }));
fs.writeFileSync(path.join(CF, 'heatmap.json'), JSON.stringify({ integrations: INTG, rows: hmRows }));

// --- per-base-type heatmap ---
const typePages = {};
for (const b of blocks) (typePages[b.type] = typePages[b.type] || new Set()).add(b.pageUrl);
const BASE_ORDER = ['cards', 'media', 'table', 'form', 'iframe-embed', 'breadcrumbs', 'hero', 'list', 'columns', 'carousel', 'tabs', 'accordion', 'video', 'text', 'unknown'];
const bpct = []; const bcnt = [];
for (const t of BASE_ORDER) {
  const set = typePages[t]; if (!set || !set.size) continue;
  const pg = set.size; const hit = INTG.map(() => 0);
  for (const u of set) { const s = pageIntg[u]; if (s) s.forEach((i) => hit[i]++); }
  const label = t === 'iframe-embed' ? 'Embed' : t.charAt(0).toUpperCase() + t.slice(1);
  bpct.push({ template: label, pg: String(pg), cells: hit.map((h) => (h === 0 ? '·' : Math.round(h / pg * 100) + '%')) });
  bcnt.push({ template: label, pg: String(pg), cells: hit.map((h) => (h === 0 ? '·' : h + '/' + pg)) });
}
fs.writeFileSync(path.join(CF, 'block-heatmap.json'), JSON.stringify({ integrations: INTG, pct: bpct, counts: bcnt }));

// --- integrations summary (site-wide) ---
const hostHits = {};
function host(u) { try { const h = new URL(u).hostname; return /^(localhost|127\.0\.0\.1)$/.test(h) ? null : h; } catch (e) { return null; } } // capture-tool / dev hosts are not site integrations
for (const p of pages) for (const s of (p.scripts || []).concat(p.iframeSrcs || [])) { const h = host(s); if (h) hostHits[h] = (hostHits[h] || 0) + 1; }
// Comprehensive third-party classification: [regex, name, category].
const KNOWN = [
  [/googletagmanager\.com/, 'Google Tag Manager', 'Tag manager'], [/tiqcdn\.com|tealium/, 'Tealium (utag)', 'Tag manager / CDP'],
  [/google-analytics\.com|analytics\.google/, 'Google Analytics', 'Analytics'], [/adobe|omtrdc|demdex|2o7\.net/, 'Adobe Analytics/Experience Cloud', 'Analytics'],
  [/siteimprove/, 'Siteimprove', 'Analytics'], [/chartbeat/, 'Chartbeat', 'Analytics'], [/go-mpulse\.net|mpulse|akstat/, 'Akamai mPulse (RUM)', 'Performance/RUM'],
  [/tvsquared/, 'TVSquared', 'Attribution'], [/infinity-tracking/, 'Infinity Call Tracking', 'Attribution'], [/adalyser/, 'Adalyser', 'TV attribution'],
  [/googleadservices|doubleclick|googlesyndication/, 'Google Ads/DoubleClick', 'Advertising'], [/bat\.bing\.com|\bbing\.com/, 'Microsoft/Bing Ads (UET)', 'Advertising'],
  [/facebook\.net|facebook\.com|fbcdn/, 'Meta (Facebook) Pixel', 'Advertising'], [/analytics\.tiktok\.com|tiktok\.com|tiktokcdn/, 'TikTok Pixel', 'Advertising'],
  [/snap\.licdn|snapchat\.com|sc-static\.net/, 'Snapchat Pixel', 'Advertising'], [/licdn|linkedin\.com/, 'LinkedIn Insight', 'Advertising'],
  [/pinimg\.com|pinterest\.com/, 'Pinterest Tag', 'Advertising'], [/redditstatic|reddit\.com/, 'Reddit Pixel', 'Advertising'],
  [/adsrvr\.org/, 'The Trade Desk', 'Advertising'], [/amazon-adsystem/, 'Amazon Ads', 'Advertising'], [/adform\.net/, 'Adform', 'Advertising'],
  [/ads-twitter|twimg|t\.co|x\.com/, 'Twitter/X Pixel', 'Advertising'], [/taboola/, 'Taboola', 'Advertising / native'], [/outbrain/, 'Outbrain', 'Advertising / native'],
  [/jivox/, 'Jivox', 'Advertising / DCO'], [/clrt\.ai|mczbf|adsymptotic/, 'Ad/DCO network', 'Advertising'], [/affec\.tv/, 'affectv', 'Advertising'], [/raptor\.digital/, 'Raptor', 'Personalization'],
  [/marketo|mktoresp|mktoweb|munchkin/, 'Marketo', 'Marketing automation'], [/eloqua|en25\.com/, 'Oracle Eloqua', 'Marketing automation'],
  [/hubspot|hs-scripts|hsforms/, 'HubSpot', 'Marketing automation'], [/pardot|pardot\.com/, 'Salesforce/Pardot', 'Marketing automation'],
  [/demandbase/, 'Demandbase', 'ABM'], [/zi-scripts|zoominfo/, 'ZoomInfo', 'ABM / data'], [/partnerstack/, 'PartnerStack', 'Partner/affiliate'],
  [/chilipiper/, 'Chili Piper', 'Scheduling / lead routing'], [/navattic/, 'Navattic', 'Interactive demos'], [/omappapi|optinmonster/, 'OptinMonster', 'Lead capture'],
  [/qualtrics|siteintercept/, 'Qualtrics', 'Survey / VoC'], [/liveperson|lpsnmedia|lpcdn|lptag|lpsn/, 'LivePerson', 'Chat / messaging'], [/hotjar/, 'Hotjar', 'CRO / heatmaps'],
  [/clarity\.ms/, 'Microsoft Clarity', 'Session replay / heatmaps'], [/rum\.hlx\.page|rum\.aem\.page/, 'Adobe RUM (Helix)', 'Real-user monitoring'],
  [/fontawesome/, 'Font Awesome kit', 'Icons / fonts'], [/^gdpr\.|cookie-?consent|consent\./, 'Consent / GDPR service', 'Consent'], [/^www\.google\.com$/, 'Google (reCAPTCHA / APIs)', 'Security / bot'],
  [/contently/, 'Contently', 'Content marketing'], [/datawrapper|dwcdn\.net|infogram/, 'Datawrapper/Infogram', 'Data viz embed'], [/pdst\.fm|podsights/, 'Podcast (Podsights)', 'Podcast attribution'],
  [/openai\.com|bzrcdn\.openai/, 'OpenAI', 'AI'], [/vev\.page|vev\.design/, 'Vev', 'Interactive content'],
  [/youtube|ytimg|youtu\.be/, 'YouTube embed', 'Video'], [/vimeo\.com/, 'Vimeo', 'Video'], [/wistia/, 'Wistia', 'Video'], [/brightcove/, 'Brightcove', 'Video'],
  [/onetrust|cookiebot|cookielaw|trustarc/, 'Consent (OneTrust/Cookiebot)', 'Consent'], [/recaptcha/, 'reCAPTCHA', 'Security / bot'],
  [/maps\.google|google\.com\/maps/, 'Google Maps', 'Maps'], [/typekit|fonts\.googleapis|fonts\.gstatic/, 'Web fonts (Typekit/Google)', 'Fonts'],
  [/jquery|cdnjs|jsdelivr|unpkg|bootstrapcdn|npmcdn|gstatic|ytimg/, 'CDN/JS libs', 'CDN / libraries'],
];
const integ = {}; const catOf = {};
for (const [h, c] of Object.entries(hostHits)) {
  if (isFirstParty(h)) continue;
  const m = KNOWN.find(([re]) => re.test(h));
  const name = m ? m[1] : 'Other third-party: ' + h;
  if (m) catOf[name] = m[2];
  integ[name] = (integ[name] || 0) + c;
}
const globals = {};
for (const p of pages) for (const g of (p.globals || [])) globals[g] = (globals[g] || 0) + 1;
fs.writeFileSync(path.join(CF, 'integrations.json'), JSON.stringify({
  integrations: Object.entries(integ).sort((a, b) => b[1] - a[1]).map(([name, hits]) => ({ name, hits, category: catOf[name] || (name.startsWith('Other third-party') ? 'Unclassified' : 'Other') })),
  globals: Object.entries(globals).sort((a, b) => b[1] - a[1]).map(([global, count]) => ({ global, count })),
  iframeHosts: [],
}));

console.log('compute-data: live pages', live.length, '| structure groups', siteStructure.length, '| docs', docs.length,
  '| url groups', urlGroups.length, '| layout heatmap rows', hmRows.length, '| block heatmap rows', bpct.length,
  '| integrations', Object.keys(integ).length);
