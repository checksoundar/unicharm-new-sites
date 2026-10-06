#!/usr/bin/env node
/*
 * build-render-set.js
 * Reads urls-all.json (from the crawl), then:
 *  1. Keeps only 200-status HTML pages (drops attachments/images/docs).
 *  2. Dedupes (strips query/anchor, normalizes /index.html -> /).
 *  3. Groups by "final path-level pattern" = parent directory + wildcard leaf.
 *  4. For pattern groups (>= MIN_GROUP pages): sample a representative subset.
 *  5. For long-tail (groups with < MIN_GROUP pages i.e. unique pages): render ALL.
 *  Emits: groups.json, render-set.json, and a human summary to stdout.
 *
 * Usage: node build-render-set.js <catalogFolder> [minGroup] [sampleN]
 */
const fs = require('fs');
const path = require('path');
const { buildClassifier } = require('./url-template.js');

const CF = process.argv[2] || __dirname;
const MIN_GROUP = parseInt(process.argv[3] || '2', 10);  // "minimal 2 pages to consider" as a pattern
const SAMPLE_N = parseInt(process.argv[4] || '4', 10);   // representative pages sampled per large pattern group

const DOC_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.rar'];
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.avif'];

const raw = JSON.parse(fs.readFileSync(path.join(CF, 'urls-all.json'), 'utf8'));
const all = raw['analysis-urls-all'];

// 1 + 2: live HTML pages, deduped
function isAttachment(u) {
  const lu = u.toLowerCase().split(/[?#]/)[0];
  return DOC_EXT.some((e) => lu.endsWith(e)) || IMG_EXT.some((e) => lu.endsWith(e));
}
function normalize(u) {
  let s = u.split(/[?#]/)[0];             // drop query + anchor
  s = s.replace(/\/index\.html$/, '/');   // index.html -> dir
  return s;
}
// Optional scope exclusions from config: excludeSegments = first-path segments to drop
// (e.g. non-English locales ["fr-ca","fr","br","mx"] or sections like ["learn-support"]).
let EXCLUDE_SEG = [];
try { EXCLUDE_SEG = JSON.parse(fs.readFileSync(path.join(CF, 'config.json'), 'utf8')).excludeSegments || []; } catch (e) { /* none */ }
const EXCLUDE_SET = new Set(EXCLUDE_SEG.map((s) => s.toLowerCase().replace(/^\/|\/$/g, '')));
function excludedByScope(u) {
  if (!EXCLUDE_SET.size) return false;
  try { const seg = new URL(u).pathname.split('/').filter(Boolean)[0] || ''; return EXCLUDE_SET.has(seg.toLowerCase()); } catch (e) { return false; }
}
const seen = new Set();
const pages = [];
let excludedByScopeCount = 0;
for (const item of all.urls) {
  if (item.status !== 200) continue;
  if (isAttachment(item.url)) continue;
  const n = normalize(item.url);
  if (isAttachment(n)) continue;
  if (seen.has(n)) continue;
  seen.add(n);
  if (excludedByScope(n)) { excludedByScopeCount++; continue; }
  pages.push(n);
}
if (EXCLUDE_SET.size) console.error(`Scope exclusions (${[...EXCLUDE_SET].join(', ')}): dropped ${excludedByScopeCount} pages`);

// 3: group by SEMANTIC URL TEMPLATE (site-agnostic). Recurring templates get sampled;
//    a template seen on few pages is its own group and is rendered IN FULL — so a page
//    whose SHAPE is unique at the lowest tree level is never sampled out.
const clf = buildClassifier(pages);
const groups = {};
const groupLabel = {};
for (const u of pages) {
  const c = clf.classify(u);
  (groups[c.template] = groups[c.template] || []).push(u);
  groupLabel[c.template] = c.label;
}

// deterministic sampling: first, last, and evenly-spaced middle picks
function sample(arr, n) {
  const s = arr.slice().sort();
  if (s.length <= n) return s;
  const picks = new Set([s[0], s[s.length - 1]]);
  const step = (s.length - 1) / (n - 1);
  for (let i = 1; i < n - 1; i++) picks.add(s[Math.round(i * step)]);
  return [...picks];
}

const patternGroups = [];
const longTail = [];
for (const [k, v] of Object.entries(groups)) {
  if (v.length >= MIN_GROUP) patternGroups.push([k, v]);
  else longTail.push([k, v]);
}
patternGroups.sort((a, b) => b[1].length - a[1].length);

// 4 + 5: render set = sampled pattern pages + ALL long-tail pages
const renderSet = new Set();
const groupMeta = {};
for (const [k, v] of patternGroups) {
  const picks = sample(v, SAMPLE_N);
  picks.forEach((u) => renderSet.add(u));
  groupMeta[k] = { total: v.length, rendered: picks.length, type: 'pattern', label: groupLabel[k] || '' };
}
for (const [k, v] of longTail) {
  v.forEach((u) => renderSet.add(u)); // render every unique/rare-shape page in full
  groupMeta[k] = { total: v.length, rendered: v.length, type: 'long-tail', label: groupLabel[k] || '' };
}

const renderList = [...renderSet].sort();

fs.writeFileSync(path.join(CF, 'groups.json'), JSON.stringify({
  captured: new Date().toISOString(),
  minGroup: MIN_GROUP, sampleN: SAMPLE_N,
  totalLivePages: pages.length,
  totalGroups: Object.keys(groups).length,
  patternGroups: patternGroups.length,
  longTailPages: longTail.length,
  groupMeta,
  groups,
}, null, 1));

fs.writeFileSync(path.join(CF, 'render-set.json'), JSON.stringify({
  captured: new Date().toISOString(),
  strategy: `pattern-groups(>=${MIN_GROUP}) sampled to ${SAMPLE_N}; all long-tail pages rendered; attachments/images excluded`,
  totalLivePages: pages.length,
  renderCount: renderList.length,
  urls: renderList,
}, null, 1));

// summary
const sampledPages = patternGroups.reduce((a, [, v]) => a + Math.min(v.length, SAMPLE_N), 0);
console.log('Live HTML pages (200, deduped):', pages.length);
console.log('Attachments/images excluded from render (docs):', all.totalDocuments);
console.log('Total path-pattern groups:', Object.keys(groups).length);
console.log(`Pattern groups (>= ${MIN_GROUP}):`, patternGroups.length,
  '- covering', patternGroups.reduce((a, [, v]) => a + v.length, 0), 'pages',
  `-> sampled to ~${sampledPages}`);
console.log('Long-tail unique pages (rendered in full):', longTail.length);
console.log('=> RENDER SET SIZE:', renderList.length);
console.log('');
console.log('Top 30 pattern groups:');
for (const [k, v] of patternGroups.slice(0, 30)) {
  console.log(String(v.length).padStart(5), '->', Math.min(v.length, SAMPLE_N), 'sampled  ', k);
}
