#!/usr/bin/env node
/*
 * consolidate-backend.js — turn backend-pages.jsonl (raw XHR/fetch calls) into
 * backend.json: a classified list of PROBABLE backend integrations/services, each
 * with a category, the hosts involved, sample endpoints, and page coverage.
 *
 * Site-agnostic. First-party API calls (same registrable domain as config.siteOrigin,
 * or a sibling brand CDN) are classified GENERICALLY by URL-path keywords
 * (identity/auth, consent, telemetry, commerce, graphql, search, forms). Third-party
 * calls are matched against a vendor table. Works on any site, not just the one this
 * was first built for.
 */
const fs = require('fs');
const path = require('path');
const CF = process.argv[2] || '.';

const recs = fs.readFileSync(path.join(CF, 'backend-pages.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pageCount = recs.length;

// --- first-party domain detection (from config.siteOrigin) ---
function registrable(h) { const p = (h || '').toLowerCase().split('.').filter(Boolean); return p.length <= 2 ? p.join('.') : p.slice(-2).join('.'); }
let ORIGIN = '';
try { ORIGIN = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')).siteOrigin || ''; } catch (e) { /* none */ }
const FP_BASE = (() => { try { return registrable(new URL(ORIGIN).hostname); } catch (e) { return ''; } })();
const FP_BRAND = (() => { try { return new URL(ORIGIN).hostname.split('.')[0]; } catch (e) { return ''; } })();
const SITE_LABEL = (FP_BRAND && FP_BRAND.length >= 2) ? (FP_BRAND.charAt(0).toUpperCase() + FP_BRAND.slice(1)) : 'First-party';
function isFirstParty(h) { h = (h || '').toLowerCase(); if (FP_BASE && (h === FP_BASE || h.endsWith('.' + FP_BASE))) return true; if (FP_BRAND && FP_BRAND.length >= 4 && h.includes(FP_BRAND)) return true; return false; }

// --- generic first-party API classifier by host+path keywords ---
// Returns [serviceName, category, note] for a first-party endpoint, or null to skip
// (static assets are not "backend integrations").
function classifyFirstParty(hostPath) {
  const s = hostPath.toLowerCase();
  const svc = (n, c, note) => [`${SITE_LABEL}: ${n}`, c, note];
  if (/\.(js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|map|json)(\?|$)/.test(s) && !/\/(api|graphql|gql|v\d|rest|service)/.test(s)) return null; // static asset
  if (/(auth|authn|oauth|login|signin|sign-in|identity|\bsso\b|session|token|visitor-?id|\bivid\b|\bsci\b)/.test(s)) return svc('Identity / Auth API', 'First-party identity', 'Sign-in / session / visitor-id services');
  if (/(consent|privacy|gdpr|ccpa|cookie)/.test(s)) return svc('Consent / Privacy API', 'First-party consent', 'Consent + privacy configuration');
  if (/(clickstream|eventbus|\bevents?\b|telemetry|beacon|collect|track|analytics|segment)/.test(s)) return svc('Telemetry / Clickstream', 'First-party telemetry', 'Event / clickstream pipeline');
  if (/(rum|perf|performance|monitor|metrix|metrics|vitals)/.test(s)) return svc('RUM / Monitoring API', 'First-party telemetry', 'Real-user monitoring / metrics');
  if (/(log|logging|error|exception)/.test(s)) return svc('Logging API', 'First-party telemetry', 'Client log / error ingestion');
  if (/(pricing|price|offers?|billing|plans?|catalog|commerce|cart|checkout|subscription|quote)/.test(s)) return svc('Pricing / Commerce API', 'First-party commerce', 'Pricing, offers, or checkout data');
  if (/(search|autocomplete|typeahead|suggest)/.test(s)) return svc('Search API', 'First-party search', 'Site search / suggestions');
  if (/(form|lead|submit|contact|subscribe|newsletter)/.test(s)) return svc('Forms / Lead API', 'First-party forms', 'Form submission / lead capture');
  if (/(graphql|\/gql)/.test(s)) return svc('GraphQL API', 'First-party platform', 'GraphQL data gateway');
  if (/(\/api\/|\/v\d+\/|\/rest\/|\/service|\/bff\/|cdn-api|content|\bcms\b|dam\b)/.test(s)) return svc('Content / App API', 'First-party platform', 'App / content back-end');
  return svc('Other first-party API', 'First-party platform', 'Uncategorised same-domain API call');
}

// --- third-party vendor table (site-agnostic): [regex, name, category, note] ---
const RULES = [
  [/segment\.com|api\.segment\.io|cdn\.segment/, 'Segment (CDP)', 'Customer data platform', 'Segment analytics.js ingest/settings'],
  [/tiqcdn|tealium/, 'Tealium (CDP)', 'Customer data platform', 'Tag/CDP delivery'],
  [/adobedc\.demdex\.net|demdex\.net|omtrdc|2o7\.net|adobe/, 'Adobe Experience Cloud', 'Analytics / experience', 'Adobe Analytics + Audience Manager'],
  [/google-analytics|analytics\.google|\/g\/collect|region\d+\.google-analytics/, 'Google Analytics (GA4)', 'Analytics', 'GA4 collect beacons'],
  [/fullstory/, 'FullStory', 'Session replay / analytics', 'Session capture'],
  [/quantummetric|contentsquare|clarity\.ms|hotjar|mouseflow|glassbox/, 'Digital-experience analytics', 'Session replay / analytics', ''],
  [/siteimprove/, 'Siteimprove', 'Analytics', ''], [/chartbeat/, 'Chartbeat', 'Analytics', ''],
  [/go-mpulse\.net|mpulse|akstat|newrelic|nr-data|datadog|sentry\.io/, 'Performance/RUM (3rd-party)', 'Performance/RUM', ''],
  [/infinity-tracking/, 'Infinity Call Tracking', 'Attribution', ''], [/tvsquared/, 'TVSquared', 'Attribution', ''],
  [/doubleclick\.net|googleadservices|googlesyndication|google\.com\/(pagead|gmp|ads)/, 'Google Ads / DoubleClick', 'Advertising', 'Conversion beacons'],
  [/px\.ads\.linkedin|linkedin\.com\/(wa|li|px)/, 'LinkedIn Ads', 'Advertising', ''], [/pinterest\.com|pinimg/, 'Pinterest Conversions', 'Advertising', ''],
  [/reddit\.com|redditstatic/, 'Reddit Conversions', 'Advertising', ''], [/adsrvr\.org/, 'The Trade Desk', 'Advertising', ''],
  [/bat\.bing|clarity\.ms|bing\.com/, 'Microsoft Ads/Clarity', 'Advertising', ''], [/tiktok/, 'TikTok Events', 'Advertising', ''],
  [/snapchat|sc-static|snap\.licdn/, 'Snapchat Conversions', 'Advertising', ''], [/facebook\.com|facebook\.net/, 'Meta Conversions', 'Advertising', ''],
  [/amazon-adsystem/, 'Amazon Ads', 'Advertising', ''], [/adform\.net/, 'Adform', 'Advertising', ''], [/taboola/, 'Taboola', 'Advertising / native', ''], [/outbrain/, 'Outbrain', 'Advertising / native', ''],
  [/clrt\.ai|celtra/, 'Celtra', 'Advertising / creative', ''], [/openai\.com/, 'OpenAI', 'Advertising / AI', ''],
  [/onetrust|cookielaw|cookiebot|trustarc/, 'OneTrust/consent (3rd-party)', 'Consent', ''],
  [/liveperson|lpsnmedia|lpcdn|lptag|lpsn/, 'LivePerson', 'Chat / messaging', ''], [/intercom|drift\.com|zendesk|freshchat/, 'Chat / helpdesk', 'Chat / messaging', ''],
  [/qualtrics|siteintercept|medallia|survicate/, 'Survey / VoC', 'Survey / VoC', ''],
  [/partnerstack|grsm\.io|partnerlinks|impact\.com|impactradius/, 'Partner / affiliate', 'Partner / affiliate', ''],
  [/chilipiper|calendly/, 'Scheduling', 'Scheduling / routing', ''], [/demandbase|6sense/, 'Demandbase/6sense', 'ABM', ''], [/zoominfo|zi-scripts/, 'ZoomInfo', 'ABM / data', ''],
  [/marketo|mktoresp|munchkin/, 'Marketo', 'Marketing automation', ''], [/eloqua|en25\.com/, 'Oracle Eloqua', 'Marketing automation', ''], [/hubspot|hs-scripts|hsforms/, 'HubSpot', 'Marketing automation', ''], [/pardot/, 'Salesforce/Pardot', 'Marketing automation', ''],
  [/contentful|contentstack|prismic|sanity\.io|aem|adobeaemcloud/, 'Headless CMS API', 'Content / CMS', ''],
  [/datawrapper|dwcdn|infogram/, 'Datawrapper/Infogram', 'Data viz', ''],
  [/youtube|ytimg|vimeo|wistia|brightcove/, 'Video platform API', 'Video', ''], [/maps\.google|maps\.googleapis/, 'Google Maps API', 'Maps', ''],
  [/recaptcha|hcaptcha|arkoselabs|datadome|perimeterx/, 'Bot / security', 'Security / bot', ''],
];

function normHostPath(hostPath) { return hostPath.slice(0, 90); }

const services = {}; // name -> {category,note,hosts:Set,endpoints:Set,pages:Set}
const unclassified = {}; // host -> {count,pages:Set,sample}
for (const rec of recs) {
  const seenSvc = new Set(); const seenHost = new Set();
  for (const call of (rec.calls || [])) {
    const sp = call.indexOf(' ');
    const method = call.slice(0, sp); const hostPath = call.slice(sp + 1);
    const host = hostPath.split('/')[0];
    let name; let category; let note;
    if (isFirstParty(host)) {
      const c = classifyFirstParty(hostPath);
      if (!c) continue; // static asset — skip
      [name, category, note] = c;
    } else {
      const m = RULES.find(([re]) => re.test(hostPath));
      if (m) { [, name, category, note] = m; } else {
        const u = unclassified[host] || (unclassified[host] = { host, count: 0, pages: new Set(), sample: method + ' ' + normHostPath(hostPath) });
        u.count++; if (!seenHost.has(host)) { u.pages.add(rec.url); seenHost.add(host); }
        continue;
      }
    }
    const s = services[name] || (services[name] = { name, category, note, hosts: new Set(), endpoints: new Set(), pages: new Set() });
    s.hosts.add(host);
    if (s.endpoints.size < 8) s.endpoints.add(method + ' ' + normHostPath(hostPath));
    if (!seenSvc.has(name)) { s.pages.add(rec.url); seenSvc.add(name); }
  }
}

const list = Object.values(services).map((s) => ({
  name: s.name, category: s.category, note: s.note,
  hosts: [...s.hosts], hostCount: s.hosts.size,
  endpoints: [...s.endpoints], pages: s.pages.size,
  coverage: Math.round(s.pages.size / pageCount * 100) + '%',
})).sort((a, b) => b.pages - a.pages || b.hostCount - a.hostCount);

const other = Object.values(unclassified).sort((a, b) => b.pages.size - a.pages.size)
  .map((u) => ({ host: u.host, pages: u.pages.size, sample: u.sample }));

const byCat = {};
for (const s of list) byCat[s.category] = (byCat[s.category] || 0) + 1;

fs.writeFileSync(path.join(CF, 'backend.json'), JSON.stringify({
  captured: new Date().toISOString(),
  sampledPages: pageCount,
  firstPartyDomain: FP_BASE,
  totalServices: list.length,
  categories: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
  services: list,
  otherHosts: other.slice(0, 40),
}, null, 1));

console.log('Sampled pages:', pageCount, '| first-party domain:', FP_BASE || '(unknown)');
console.log('Probable backend integrations:', list.length, '| unclassified hosts:', other.length);
console.log('\n=== By category ===');
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(3), c);
console.log('\n=== Services (by page coverage) ===');
for (const s of list) console.log(String(s.pages).padStart(3) + 'pg  ' + s.category.padEnd(26) + '  ' + s.name);
