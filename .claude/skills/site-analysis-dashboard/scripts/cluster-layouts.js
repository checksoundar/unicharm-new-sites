#!/usr/bin/env node
/*
 * cluster-layouts.js — cluster rendered pages into layout templates + integrations.
 *
 * Inputs: pages.jsonl (fingerprints), groups.json (pattern-group -> all pages).
 * Clustering: exact structural signature, refined by primary site-section + block
 *   family, so "text" news pages and "text" policy pages don't over-merge.
 * Extrapolation: each rendered page represents its pattern group; a template's
 *   full-population estimate = sum of (group.total / group.rendered) over its members.
 * Also aggregates third-party integration signals across all pages.
 *
 * Outputs: layouts.json, integrations.json, and a summary to stdout.
 */
const fs = require('fs');
const path = require('path');

const CF = process.argv[2] || __dirname;
const pages = fs.readFileSync(path.join(CF, 'pages.jsonl'), 'utf8').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.status === 'ok');
const groupsData = JSON.parse(fs.readFileSync(path.join(CF, 'groups.json'), 'utf8'));

// First-party domain detection (site-agnostic): derive the registrable domain from
// config.siteOrigin (or the most common crawled host) so first-party hosts + their
// asset CDNs are excluded from the third-party integrations list on ANY site.
function registrable(hostname) {
  const parts = (hostname || '').toLowerCase().split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}
function firstPartyMatcher() {
  let origin = '';
  try { origin = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')).siteOrigin || ''; } catch (e) { /* none */ }
  let base = '';
  try { base = registrable(new URL(origin).hostname); } catch (e) { /* none */ }
  if (!base) { // fallback: most frequent host across crawled pages
    const hc = {}; for (const p of pages) { try { const h = registrable(new URL(p.url).hostname); hc[h] = (hc[h] || 0) + 1; } catch (e) {} }
    base = Object.entries(hc).sort((a, b) => b[1] - a[1]).map(([h]) => h)[0] || '';
  }
  // brand token (e.g. "quickbooks" from quickbooks.intuit.com) also matches sibling asset CDNs (quickbooks.com, intuitcdn.net)
  const brand = (() => { try { return new URL(origin).hostname.split('.')[0]; } catch (e) { return ''; } })();
  return (hostname) => {
    const h = (hostname || '').toLowerCase();
    if (base && (h === base || h.endsWith('.' + base))) return true;
    if (brand && brand.length >= 4 && h.includes(brand)) return true; // sibling brand CDNs
    return false;
  };
}
const isFirstParty = firstPartyMatcher();

// map each URL -> its pattern group meta (for extrapolation weight)
function groupKey(u) {
  const p = u.replace(/^https?:\/\/[^/]+/, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '/(root-level)/*';
  return '/' + parts.slice(0, -1).join('/') + '/*';
}
const weightOf = (u) => {
  const gm = groupsData.groupMeta[groupKey(u)];
  if (!gm || !gm.rendered) return 1;
  return gm.total / gm.rendered; // pages represented per rendered sample
};

// primary section = first 2 path segments after locale (locale + section)
function sectionOf(u) {
  const parts = u.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
  const locales = ['en', 'jp', 'ja', 'brasil', 'korea', 'philippines', 'tw', 'oceania', 'vietnam', 'gallery'];
  let loc = 'root'; let sec = '(home)';
  if (parts.length) {
    if (locales.includes(parts[0])) { loc = parts[0]; sec = parts[1] || '(home)'; }
    else { loc = 'root'; sec = parts[0]; }
  }
  return { loc, sec };
}
function localeOf(u) { return sectionOf(u).loc; }

// dominant block family drives naming
function familyOf(sig) {
  if (!sig) return 'empty';
  const b = sig.split('>');
  const has = (t) => b.includes(t);
  if (has('form')) return 'form';
  if (has('hero') && has('cards')) return 'hero+cards';
  if (has('carousel')) return 'carousel';
  if (has('accordion')) return 'accordion';
  if (has('tabs')) return 'tabs';
  if (has('iframe-embed')) return 'embed';
  if (has('table')) return 'table';
  if (has('cards')) return 'cards';
  if (has('hero')) return 'hero';
  if (b.every((x) => x === 'list')) return 'list';
  if (has('media') && has('text')) return 'media+text';
  if (b.every((x) => x === 'text')) return 'text';
  if (has('breadcrumbs')) return 'breadcrumbed';
  return b[0] || 'other';
}

// cluster key: signature (captures structure). Store rich members.
const clusters = {};
for (const p of pages) {
  const key = p.signature || '(empty)';
  const c = clusters[key] || (clusters[key] = { signature: key, family: familyOf(p.signature), rendered: 0, estPop: 0, urls: [], sections: {}, locales: {}, blockCountMode: {} });
  c.rendered += 1;
  c.estPop += weightOf(p.url);
  if (c.urls.length < 8) c.urls.push(p.url);
  const { loc, sec } = sectionOf(p.url);
  c.sections[sec] = (c.sections[sec] || 0) + 1;
  c.locales[loc] = (c.locales[loc] || 0) + 1;
  c.blockCountMode[p.blockCount] = (c.blockCountMode[p.blockCount] || 0) + 1;
}
const clusterList = Object.values(clusters).map((c) => {
  c.estPop = Math.round(c.estPop);
  c.topSections = Object.entries(c.sections).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`);
  c.topLocales = Object.entries(c.locales).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
  return c;
}).sort((a, b) => b.estPop - a.estPop);

// human-friendly name per cluster
function nameCluster(c, i) {
  const fam = c.family;
  const topSec = (c.topSections[0] || '').replace(/\(\d+\)$/, '');
  const map = {
    text: 'article-text', table: 'data-table', list: 'section-nav-list', 'media+text': 'media-article',
    cards: 'card-grid', form: 'form-page', hero: 'hero-page', 'hero+cards': 'hero-landing',
    carousel: 'carousel-page', accordion: 'accordion-page', tabs: 'tabbed-page', embed: 'embed-page',
    breadcrumbed: 'breadcrumb-page', empty: 'minimal-page', other: 'mixed-layout',
  };
  const base = map[fam] || fam;
  return `${base}`;
}
clusterList.forEach((c, i) => { c.name = nameCluster(c, i); });

// --- integrations aggregation ---
const hosts = {}; const globalsCount = {}; const iframeHosts = {};
function host(u) { try { return new URL(u).hostname; } catch (e) { return null; } }
for (const p of pages) {
  const w = weightOf(p.url);
  for (const s of (p.scripts || [])) { const h = host(s); if (h) hosts[h] = (hosts[h] || 0) + 1; }
  for (const f of (p.iframeSrcs || [])) { const h = host(f); if (h) iframeHosts[h] = (iframeHosts[h] || 0) + 1; }
  for (const g of (p.globals || [])) globalsCount[g] = (globalsCount[g] || 0) + 1;
}
// classify notable 3rd-party hosts. Each entry: [regex, name, category].
const KNOWN = [
  // Tag managers / CDPs
  [/googletagmanager\.com/, 'Google Tag Manager', 'Tag manager'],
  [/tiqcdn\.com|tealium/, 'Tealium (utag)', 'Tag manager / CDP'],
  [/ensighten|launchdarkly/, 'Ensighten', 'Tag manager'],
  // Web analytics
  [/google-analytics\.com|analytics\.google/, 'Google Analytics', 'Analytics'],
  [/adobe|omtrdc|demdex|2o7\.net|sc\.omtrdc/, 'Adobe Analytics/Experience Cloud', 'Analytics'],
  [/siteimproveanalytics|siteimprove/, 'Siteimprove', 'Analytics'],
  [/chartbeat/, 'Chartbeat', 'Analytics'],
  [/go-mpulse\.net|mpulse|akstat|akamaihd/, 'Akamai mPulse (RUM)', 'Performance/RUM'],
  [/tvsquared/, 'TVSquared', 'Attribution'],
  [/infinity-tracking/, 'Infinity Call Tracking', 'Attribution'],
  [/adalyser/, 'Adalyser', 'TV attribution'],
  // Advertising / pixels
  [/googleadservices|doubleclick|googlesyndication|g\.doubleclick/, 'Google Ads/DoubleClick', 'Advertising'],
  [/bat\.bing\.com|bing\.com/, 'Microsoft/Bing Ads (UET)', 'Advertising'],
  [/facebook\.net|facebook\.com|fbcdn/, 'Meta (Facebook) Pixel', 'Advertising'],
  [/analytics\.tiktok\.com|tiktok\.com|tiktokcdn/, 'TikTok Pixel', 'Advertising'],
  [/snap\.licdn\.com|snapchat\.com|sc-static\.net/, 'Snapchat Pixel', 'Advertising'],
  [/licdn|linkedin\.com/, 'LinkedIn Insight', 'Advertising'],
  [/pinimg\.com|pinterest\.com|pinimg|ct\.pinterest/, 'Pinterest Tag', 'Advertising'],
  [/redditstatic|reddit\.com/, 'Reddit Pixel', 'Advertising'],
  [/adsrvr\.org/, 'The Trade Desk', 'Advertising'],
  [/amazon-adsystem/, 'Amazon Ads', 'Advertising'],
  [/adform\.net/, 'Adform', 'Advertising'],
  [/ads-twitter|twitter\.com|twimg|t\.co|x\.com/, 'Twitter/X Pixel', 'Advertising'],
  [/taboola/, 'Taboola', 'Advertising / native'],
  [/outbrain/, 'Outbrain', 'Advertising / native'],
  [/jivox/, 'Jivox', 'Advertising / DCO'],
  [/adsymptotic|adalyser|mczbf|adform|clrt\.ai|jivox|adsrvr|adalyser|tvsquared|adalyser/, 'Ad/DCO network', 'Advertising'],
  [/affec\.tv|go\.affec/, 'affectv', 'Advertising'],
  [/raptor\.digital/, 'Raptor', 'Advertising / personalization'],
  // Marketing automation / MAP / CRM
  [/marketo|mktoresp|mktoweb|munchkin/, 'Marketo', 'Marketing automation'],
  [/eloqua|en25\.com/, 'Oracle Eloqua', 'Marketing automation'],
  [/hubspot|hs-scripts|hsforms/, 'HubSpot', 'Marketing automation'],
  [/salesforce|pardot/, 'Salesforce/Pardot', 'Marketing automation'],
  [/demandbase/, 'Demandbase', 'ABM'],
  [/zi-scripts|zoominfo/, 'ZoomInfo', 'ABM / data'],
  [/partnerstack/, 'PartnerStack', 'Partner/affiliate'],
  [/chilipiper/, 'Chili Piper', 'Scheduling / lead routing'],
  [/navattic/, 'Navattic', 'Interactive demos'],
  [/omappapi|optinmonster/, 'OptinMonster', 'Lead capture'],
  // CRO / feedback / chat
  [/qualtrics|siteintercept/, 'Qualtrics', 'Survey / VoC'],
  [/liveperson|lpsnmedia|lpcdn|lptag|lpsn/, 'LivePerson', 'Chat / messaging'],
  [/hotjar/, 'Hotjar', 'CRO / heatmaps'],
  [/clarity\.ms/, 'Microsoft Clarity', 'Session replay / heatmaps'],
  [/rum\.hlx\.page|rum\.aem\.page/, 'Adobe RUM (Helix)', 'Real-user monitoring'],
  [/fontawesome/, 'Font Awesome kit', 'Icons / fonts'],
  [/^gdpr\.|cookie-?consent|consent\./, 'Consent / GDPR service', 'Consent'],
  [/contently/, 'Contently', 'Content marketing'],
  [/datawrapper|dwcdn\.net/, 'Datawrapper', 'Data viz embed'],
  [/pdst\.fm|megaphone|simplecast/, 'Podcast (Podsights)', 'Podcast attribution'],
  [/openai\.com|bzrcdn\.openai/, 'OpenAI', 'AI'],
  [/vev\.page|vev\.design/, 'Vev', 'Interactive content'],
  // Video / media
  [/youtube\.com|youtu\.be|ytimg/, 'YouTube embed', 'Video'],
  [/vimeo\.com/, 'Vimeo', 'Video'],
  [/wistia|wistia\.net/, 'Wistia', 'Video'],
  [/brightcove/, 'Brightcove', 'Video'],
  // Consent / maps / fonts / infra
  [/cookiebot|onetrust|cookielaw|trustarc/, 'Consent (OneTrust/Cookiebot)', 'Consent'],
  [/^www\.google\.com$/, 'Google (reCAPTCHA / APIs)', 'Security / bot'],
  [/recaptcha|gstatic\.com\/recaptcha/, 'reCAPTCHA', 'Security / bot'],
  [/google\.com\/maps|maps\.google/, 'Google Maps', 'Maps'],
  [/typekit|use\.typekit|fonts\.googleapis|fonts\.gstatic/, 'Web fonts (Typekit/Google)', 'Fonts'],
  [/cloudflare|cdnjs|jsdelivr|unpkg|jquery|bootstrapcdn|npmcdn|gstatic|ytimg/, 'CDN/JS libs', 'CDN / libraries'],
];
const CATEGORY = {};
const integrations = {};
function tally(h, cnt) {
  const m = KNOWN.find(([re]) => re.test(h));
  const name = m ? m[1] : 'Other third-party: ' + h;
  if (m) CATEGORY[name] = m[2];
  integrations[name] = (integrations[name] || 0) + cnt;
}
for (const [h, cnt] of Object.entries(hosts)) { if (!isFirstParty(h)) tally(h, cnt); }
for (const [h, cnt] of Object.entries(iframeHosts)) { if (!isFirstParty(h)) tally(h, cnt); }

fs.writeFileSync(path.join(CF, 'layouts.json'), JSON.stringify({
  captured: new Date().toISOString(),
  renderedPages: pages.length,
  distinctSignatures: clusterList.length,
  templates: clusterList,
}, null, 1));
fs.writeFileSync(path.join(CF, 'integrations.json'), JSON.stringify({
  captured: new Date().toISOString(),
  integrations: Object.entries(integrations).sort((a, b) => b[1] - a[1]).map(([name, hits]) => ({ name, hits, category: CATEGORY[name] || (name.startsWith('Other third-party') ? 'Unclassified' : 'Other') })),
  thirdPartyHosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([h, c]) => ({ host: h, count: c })),
  globals: Object.entries(globalsCount).sort((a, b) => b[1] - a[1]).map(([g, c]) => ({ global: g, count: c })),
  iframeHosts: Object.entries(iframeHosts).sort((a, b) => b[1] - a[1]).map(([h, c]) => ({ host: h, count: c })),
}, null, 1));

console.log('Rendered pages clustered:', pages.length);
console.log('Distinct layout signatures:', clusterList.length);
console.log('');
console.log('=== Layout templates (est. full-population pages) ===');
for (const c of clusterList.slice(0, 30)) {
  console.log(String(c.estPop).padStart(5), 'pp  rendered=' + String(c.rendered).padStart(3),
    ' ', c.name.padEnd(16), (c.signature || '').slice(0, 46).padEnd(46), '| ', c.topSections.slice(0, 3).join(' '));
}
console.log('');
console.log('=== Third-party integrations detected ===');
for (const [n, h] of Object.entries(integrations).sort((a, b) => b[1] - a[1])) console.log(String(h).padStart(5), n);
console.log('');
console.log('=== Global objects ===');
for (const g of Object.entries(globalsCount).sort((a, b) => b[1] - a[1])) console.log(String(g[1]).padStart(4), g[0]);
