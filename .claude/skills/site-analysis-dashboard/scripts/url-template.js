/*
 * url-template.js — site-agnostic URL → semantic template classifier (shared module).
 *
 * Given the full list of live URLs, learns which path segments are recurring "sections"
 * (low-cardinality, structural) vs one-off "slugs" (high-cardinality content ids), and
 * derives a stable TEMPLATE string per URL, e.g.
 *     /au/payroll/features         -> /{locale}/{section}/{page}
 *     /r/accounting/what-is-x      -> /r/{topic}/{article}
 *     /accounting/invoicing/billing-> /{product}/{path…}
 * plus a group id + human label. Recurring templates get sampled downstream; a template
 * seen on only a handful of URLs is its own group and is always inspected in full — so a
 * page whose SHAPE is unique at the lowest tree level is never sampled out.
 *
 * Pure/no-deps. Exported: buildClassifier(urls) -> { classify(url) -> {template,label,groupId,special} }.
 */

// A segment looks like a locale code: xx or xx-xx / xx_xx (ISO-ish), lowercased.
const LOCALE_RE = /^[a-z]{2}([-_][a-z]{2,3})?$/;
// Segment looks like a "slug"/content id rather than a structural section.
function looksSlug(seg) {
  if (/^\d+$/.test(seg)) return true;                 // pure number id
  if (/[0-9]/.test(seg) && /[a-z]/i.test(seg) && seg.length >= 8) return true; // mixed id (app_b7rsf5iume)
  if (seg.length >= 25) return true;                  // very long -> article slug
  if ((seg.match(/-/g) || []).length >= 3) return true; // many hyphens -> article/headline slug
  return false;
}

function pathSegs(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean).map((s) => s.toLowerCase()); } catch (e) { return null; }
}

function buildClassifier(urls) {
  // 1) learn locale segments: first-segment codes matching LOCALE_RE that recur across
  //    multiple distinct second-segments (a real locale root, not a coincidental 2-letter page).
  const firstSeg = {}; const firstToSecond = {};
  for (const u of urls) {
    const p = pathSegs(u); if (!p || !p.length) continue;
    const a = p[0];
    firstSeg[a] = (firstSeg[a] || 0) + 1;
    if (p[1]) { (firstToSecond[a] = firstToSecond[a] || new Set()).add(p[1]); }
  }
  const locales = new Set(Object.keys(firstSeg).filter((s) => LOCALE_RE.test(s)
    && ((firstToSecond[s] && firstToSecond[s].size >= 2) || firstSeg[s] >= 3)));

  // 2) learn which first-level "sections" are structural (recur across several pages).
  const SECTION_MIN = 4; // a first segment seen on >=4 URLs is treated as a real section
  const sections = new Set(Object.keys(firstSeg).filter((s) => firstSeg[s] >= SECTION_MIN && !locales.has(s)));

  function classify(url) {
    const p = pathSegs(url);
    if (p === null) return { template: '/{malformed}', label: 'Malformed / unparseable URL', groupId: 'malformed', special: 'malformed' };
    // special buckets
    if (/%2f|%e2|%80|%98|'|\s|https?:\/\/.*https?:/i.test(new URL(url).pathname)) {
      return { template: '/{malformed}', label: 'Malformed / double-encoded URLs', groupId: 'malformed', special: 'malformed' };
    }
    if (p[0] === 'fragments') return { template: '/fragments/{type}/{id}', label: 'CMS content fragments (non-page)', groupId: 'fragments', special: 'fragment' };
    if (p.length === 0) return { template: '/', label: 'Homepage & root', groupId: 'home' };

    // Template is built from SHAPE, not literal deep-section names: only the top-level
    // section (or {locale}, or the well-known "r" hub) stays literal. Deeper structural
    // segments become {topic}/{section}/{page} tokens and content ids become {slug}/{id}.
    // This means /r/payroll/x and /r/taxes/y collapse to ONE template (/r/{topic}/{article}),
    // while a page with a genuinely unique shape gets its own template and is never sampled out.
    const out = [];
    let localePrefix = false; let firstLiteral = null;
    for (let i = 0; i < p.length; i++) {
      const seg = p[i];
      if (i === 0) {
        if (locales.has(seg)) { out.push('{locale}'); localePrefix = true; }
        else if (seg === 'r') { out.push('r'); firstLiteral = 'r'; }
        else if (sections.has(seg)) { out.push(seg); firstLiteral = seg; }
        else { out.push('{page}'); firstLiteral = '{page}'; }
        continue;
      }
      // content-depth = position within the path (1 = section level, 2 = page level, ...).
      // A leading {locale} does not add depth, so /au/pricing → depth 1 (a section), matching
      // the same shape as /accounting (non-locale section at depth 1).
      const depth = localePrefix ? i : i; // i works for both: seg[0] is the literal/locale
      if (looksSlug(seg)) { out.push(i === p.length - 1 ? '{slug}' : '{id}'); continue; }
      if (firstLiteral === 'r') { out.push(depth === 1 ? '{topic}' : '{article}'); continue; }
      out.push(depth === 1 ? '{section}' : (depth === 2 ? '{page}' : '{path…}'));
    }
    // collapse very deep paths (content-depth > 3) into a trailing wildcard for readability.
    const contentDepth = localePrefix ? out.length - 1 : out.length;
    let keep = out;
    if (contentDepth > 3) keep = out.slice(0, localePrefix ? 4 : 3).concat('{path…}');
    const tmpl = '/' + keep.join('/');
    const label = labelFor(out, localePrefix, firstLiteral);
    return { template: tmpl, label, groupId: tmpl };
  }

  return { classify, locales: [...locales], sections: [...sections] };
}

function labelFor(out, localePrefix, firstLiteral) {
  if (!out.length) return 'Homepage & root';
  const depth = localePrefix ? out.length - 1 : out.length; // content depth
  if (localePrefix) {
    if (depth === 0) return 'Locale homepages';
    if (depth === 1) return 'Locale section / landing pages';
    if (depth === 2) return 'Locale sub-pages';
    return 'Locale deep pages';
  }
  if (firstLiteral === 'r') {
    if (depth === 1) return 'Resource centre hub';
    if (depth === 2) return 'Resource topic hubs';
    if (depth === 3) return 'Resource articles';
    return 'Resource deep pages';
  }
  if (firstLiteral === '{page}') return 'Root-level product & marketing pages';
  const s = firstLiteral || 'section';
  if (depth === 1) return `${cap(s)} — landing`;
  if (depth === 2) return `${cap(s)} section pages`;
  if (depth === 3) return `${cap(s)} sub-pages`;
  return `${cap(s)} deep pages`;
}
function cap(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }

module.exports = { buildClassifier };
