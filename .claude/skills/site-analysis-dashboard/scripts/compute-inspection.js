#!/usr/bin/env node
/*
 * compute-inspection.js — URL-coverage transparency data for the dashboard.
 *
 * Groups every live URL by its SEMANTIC URL TEMPLATE (via url-template.js — locale-aware,
 * section-vs-slug, depth-aware), assigns each a Group ID + human label, and tags each with a
 * coverage CATEGORY derived from the render-set decision:
 *   - full     : every page in the template group was rendered (selected == total)
 *   - sampled  : some but not all were rendered (recurring shape — representative sample)
 *   - excluded : none were rendered (dropped from scope, e.g. by an exclude filter/locale)
 *
 * Because grouping is by URL *shape*, a page whose structure is unique at the lowest tree
 * level is its own group — so it is rendered in full and reported here, never silently missed.
 *
 * Site-agnostic. Reads urls-all.json (all live pages) + render-set.json (what was rendered).
 * Usage: node compute-inspection.js <catalogFolder>
 */
const fs = require('fs');
const path = require('path');
const { buildClassifier } = require('./url-template.js');
const CF = process.argv[2] || '.';

const all = JSON.parse(fs.readFileSync(path.join(CF, 'urls-all.json'), 'utf8'))['analysis-urls-all'];
const rendered = new Set(JSON.parse(fs.readFileSync(path.join(CF, 'render-set.json'), 'utf8')).urls);

const DOC = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.rar'];
const IMG = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.avif'];
const isAtt = (u) => { const lu = u.toLowerCase().split(/[?#]/)[0]; return DOC.some((e) => lu.endsWith(e)) || IMG.some((e) => lu.endsWith(e)); };
const norm = (u) => { let s = u.split(/[?#]/)[0]; s = s.replace(/\/index\.html$/, '/'); if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); return s; };

// live + all (with status) — dedup by normalized URL, keep best status
const seen = new Set(); const live = []; const statusByUrl = {};
for (const it of all.urls) {
  if (isAtt(it.url)) continue;
  const n = norm(it.url);
  statusByUrl[n] = Math.min(statusByUrl[n] || 999, it.status); // keep the "best" (lowest) status seen
  if (it.status !== 200) continue;
  if (seen.has(n)) continue; seen.add(n);
  live.push(n);
}
// classifier is learned from live pages (the real structure)
const clf = buildClassifier(live);

// group ALL parseable non-attachment URLs (incl. non-200) by template so the coverage table
// also surfaces dead patterns (e.g. all-404 fragment/compare templates).
const seenAll = new Set(); const groups = {};
for (const it of all.urls) {
  if (isAtt(it.url)) continue;
  const n = norm(it.url); if (seenAll.has(n)) continue; seenAll.add(n);
  const c = clf.classify(n);
  const g = groups[c.template] || (groups[c.template] = { template: c.template, label: c.label, total: 0, selected: 0, non200: 0, examples: [] });
  g.total++;
  if (rendered.has(n)) g.selected++;
  if ((statusByUrl[n] || 200) !== 200) g.non200++;
  if (g.examples.length < 3) g.examples.push(n);
}

let gid = 0;
const rows = Object.values(groups).sort((a, b) => b.total - a.total).map((g) => {
  const skipped = g.total - g.selected;
  let category;
  if (g.selected === 0) category = 'excluded';
  else if (g.selected >= g.total) category = 'full';
  else category = 'sampled';
  return {
    groupId: 'G' + String(gid++).padStart(2, '0'),
    template: g.template, label: g.label,
    total: g.total, selected: g.selected, skipped, non200: g.non200,
    category, example: (g.examples[0] || '').replace(/^https?:\/\/[^/]+/, ''),
  };
});

const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
const full = rows.filter((r) => r.category === 'full');
const sampled = rows.filter((r) => r.category === 'sampled');
const excluded = rows.filter((r) => r.category === 'excluded');
const selInspect = {
  totalGroups: rows.length,
  totalLive: sum(rows, (r) => r.total - r.non200), totalUrls: sum(rows, (r) => r.total),
  selectedTotal: sum(rows, (r) => r.selected), skippedTotal: sum(rows, (r) => r.skipped),
  non200Total: sum(rows, (r) => r.non200),
  // names kept for dashboard back-compat: nonR* = fully-inspected, r* = sampled
  nonRrendered: sum(full, (r) => r.selected), nonRtotal: sum(full, (r) => r.total), fullGroups: full.length,
  rRendered: sum(sampled, (r) => r.selected), rTotal: sum(sampled, (r) => r.total), rGroups: sampled.length,
  exclTotal: sum(excluded, (r) => r.total), exclGroups: excluded.length,
  nonEnExcluded: sum(excluded, (r) => r.total),
};

fs.writeFileSync(path.join(CF, 'inspection.json'), JSON.stringify({
  captured: new Date().toISOString(),
  locales: clf.locales, sections: clf.sections,
  selInspect, rows,
}, null, 1));
console.log('inspection.json:', rows.length, 'template groups |', 'full:', full.length, 'sampled:', sampled.length, 'excluded:', excluded.length);
console.log('pages — inspected:', selInspect.selectedTotal, 'skipped:', selInspect.skippedTotal, 'non-200:', selInspect.non200Total, 'of', selInspect.totalUrls, 'urls');
console.log('\n=== Template groups (by size) ===');
for (const r of rows.slice(0, 30)) console.log(`  ${r.groupId}  ${String(r.total).padStart(4)}  ${r.category.padEnd(8)}  ${r.template.padEnd(32)}  ${r.label}`);
