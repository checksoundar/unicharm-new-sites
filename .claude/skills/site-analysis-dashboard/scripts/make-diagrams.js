#!/usr/bin/env node
/*
 * make-diagrams.js — render two pictorial methodology step-diagrams as JPEGs.
 * Each diagram: block screenshot → 5-tier detection cascade (matched/skipped)
 *   → measured fingerprint → final variant label.
 * Reads two chosen block instances (recognized + unknown) from block-catalog.json.
 * Writes diagram JPEGs to shots/ and returns their base64 for METHOD_IMAGES.
 * Usage: node make-diagrams.js <CF>
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CF = process.argv[2] || __dirname;
const cat = JSON.parse(fs.readFileSync(path.join(CF, 'block-catalog.json')));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
// avoid consent-overlay / cookie crops as examples
const BAD = /cookie|consent|opt-?out|privacy|do not sell/i;
function goodImg(f) { try { return fs.statSync(path.join(CF, 'blocks', f)).size > 12000; } catch (e) { return false; } }
function pick(base, opts) {
  opts = opts || {};
  let vs = cat.variants.filter((v) => v.base === base).sort((a, b) => b.instances - a.instances);
  vs = vs.filter((v) => !BAD.test(v.topLabel || '') && goodImg(v.repFile));
  if (opts.label) { const w = vs.find((v) => v.topLabel); if (w) return w; }
  return vs[0] || cat.variants.filter((v) => v.base === base)[0];
}
// Recognised example: prefer cards, else the largest recognised (non-unknown) base type present.
const recognisedOrder = ['cards', 'media', 'table', 'form', 'hero', 'list', 'iframe-embed', 'breadcrumbs', 'text'];
let cards = pick('cards', { label: true });
if (!cards) { for (const bt of recognisedOrder) { cards = pick(bt, { label: true }); if (cards) break; } }
// Second example: prefer an unknown/custom block; else fall back to a DIFFERENT recognised type.
let unknown = pick('unknown', { label: true });
if (!unknown) {
  for (const bt of recognisedOrder) {
    if (cards && bt === cards.base) continue;
    const p = pick(bt, { label: true });
    if (p) { unknown = p; break; }
  }
}
const b64file = (f) => { try { return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(CF, 'blocks', f)).toString('base64'); } catch (e) { return ''; } };

// A diagram = title + block screenshot + 5 tiers + fingerprint + label
function diagramHtml(d) {
  const tier = (n, name, ex, on) => `<div class="tier ${on ? 'on' : 'off'}">
      <div class="tn">${on ? '✓' : '·'} Tier ${n}</div>
      <div class="ts"><b>${esc(name)}</b><span>${esc(ex)}</span></div></div>`;
  const feat = d.fingerprint.map((f) => `<span class="fp">${esc(f)}</span>`).join('');
  return `<!DOCTYPE html><html><head><meta charset=utf-8><style>
  *{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans CJK JP",sans-serif}
  body{width:760px;background:#fff;color:#1c1e21;padding:0}
  .badge{display:inline-block;background:${d.accent};color:#fff;font-size:12px;font-weight:700;padding:3px 11px;border-radius:20px;font-family:ui-monospace,Menlo,monospace}
  .head{padding:18px 22px 14px;border-bottom:1px solid #eee}
  .head h4{font-size:17px;margin:9px 0 6px}.head p{font-size:13px;color:#666;line-height:1.5}
  .shot{background:#f0f1f3;padding:14px 22px;border-bottom:1px solid #eee}
  .shot img{width:100%;max-height:300px;object-fit:cover;object-position:top;border:1px solid #ddd;border-radius:6px;display:block}
  .flow{padding:16px 22px}
  .flow h5{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-bottom:10px}
  .tier{display:flex;gap:12px;align-items:flex-start;padding:8px 10px;border-radius:8px;margin-bottom:5px}
  .tier.on{background:#e5f5ec}.tier.off{background:#f7f7f8;opacity:.6}
  .tn{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;min-width:64px;color:#0a7c3f}
  .tier.off .tn{color:#aaa}
  .ts b{font-size:12.5px;display:block}.ts span{font-size:11.5px;color:#666}
  .arrow{text-align:center;color:#bbb;font-size:16px;margin:2px 0}
  .fpbox{padding:14px 22px;background:#fafafb;border-top:1px solid #eee}
  .fpbox h5{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-bottom:8px}
  .fp{display:inline-block;background:#eef;border:1px solid #dde;border-radius:6px;padding:3px 9px;font-size:11.5px;margin:0 4px 4px 0;font-family:ui-monospace,Menlo,monospace;color:#334}
  .label{padding:16px 22px;border-top:1px solid #eee}
  .label h5{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-bottom:6px}
  .label .v{font-family:ui-monospace,Menlo,monospace;font-size:15px;font-weight:700;color:${d.accent}}
  .label .m{font-size:12px;color:#666;margin-top:4px}
  </style></head><body>
   <div class="head"><span class="badge">${esc(d.badge)}</span><h4>${esc(d.title)}</h4><p>${esc(d.desc)}</p></div>
   <div class="shot"><img src="${d.img}" alt=""></div>
   <div class="flow"><h5>Detection cascade — first match wins</h5>
    ${d.tiers.map((t, i) => tier(i + 1, t.name, t.ex, t.on)).join('')}
   </div>
   <div class="fpbox"><h5>Measured fingerprint</h5>${feat}</div>
   <div class="label"><h5>Result</h5><div class="v">${esc(d.result)}</div><div class="m">${esc(d.resultNote)}</div></div>
  </body></html>`;
}

// Build a "recognised type" diagram for any base type v.
function recognisedDiagram(v) {
  const cap = v.base.charAt(0).toUpperCase() + v.base.slice(1);
  return {
    accent: '#0265dc', badge: 'EXAMPLE A · recognised type',
    title: `A block that IS a standard type (${cap})`,
    desc: `A recurring ${v.base} block${v.topLabel ? ` ("${v.topLabel}")` : ''}. Its markup carries a recognisable signal (class keyword / semantic element), so the detector types it automatically.`,
    img: b64file(v.repFile),
    tiers: [
      { name: 'Class / id keywords', ex: `matched → ${v.base}`, on: true },
      { name: 'Semantic HTML', ex: '<table> / <form> / <iframe>', on: false },
      { name: 'Content heuristics', ex: '≥2 images or ≥4 links confirm a grid', on: false },
      { name: 'Media vs text', ex: 'image with little text → media', on: false },
      { name: 'Fallback → unknown', ex: 'no signal → custom', on: false },
    ],
    fingerprint: (v.key.split('::')[1] || '').split('|').filter(Boolean),
    result: `${v.base} · ${v.topLabel || v.base + ' variant'}`,
    resultNote: `Recognised as base type ${v.base}. This variant recurs on ${v.pagesFound} page(s).`,
  };
}
// Build the "Example B" diagram — unknown/custom if available, else a second recognised type.
function secondDiagram(v, isUnknown) {
  if (isUnknown) {
    return {
      accent: '#c8102e', badge: 'EXAMPLE B · custom / unknown',
      title: 'A block that is NOT a standard type (Unknown)',
      desc: 'A composite section combining a banner, heading and supporting elements. Its container carries no standard class keyword and is not a table/form/iframe — so no rule recognises it.',
      img: b64file(v.repFile),
      tiers: [
        { name: 'Class / id keywords', ex: 'no hero / card / carousel / tab keyword', on: false },
        { name: 'Semantic HTML', ex: 'not a <table>, <form> or <iframe>', on: false },
        { name: 'Content heuristics', ex: 'no single dominant grid signal', on: false },
        { name: 'Media vs text', ex: 'too much composite structure for prose', on: false },
        { name: 'Fallback → unknown', ex: 'composite, no signal → custom block', on: true },
      ],
      fingerprint: (v.key.split('::')[1] || '').split('|').filter(Boolean),
      result: 'unknown · custom block',
      resultNote: `No match at Tiers 1–4 → folded into the unknown/custom group. Recurs on ${v.pagesFound} page(s); warrants manual review before build.`,
    };
  }
  const cap = v.base.charAt(0).toUpperCase() + v.base.slice(1);
  const semantic = ['table', 'form', 'iframe-embed'].includes(v.base);
  return {
    accent: '#0a7c3f', badge: 'EXAMPLE B · recognised type',
    title: `A second standard type (${cap})`,
    desc: `A recurring ${v.base} block${v.topLabel ? ` ("${v.topLabel}")` : ''}. This site had no unrecognised blocks, so a second recognised family is shown.`,
    img: b64file(v.repFile),
    tiers: [
      { name: 'Class / id keywords', ex: semantic ? 'no keyword match here' : `matched → ${v.base}`, on: !semantic },
      { name: 'Semantic HTML', ex: `${v.base === 'iframe-embed' ? '<iframe>' : '<' + v.base + '>'} element`, on: semantic },
      { name: 'Content heuristics', ex: 'image/link/list ratios', on: false },
      { name: 'Media vs text', ex: 'image with little text → media', on: false },
      { name: 'Fallback → unknown', ex: 'no signal → custom', on: false },
    ],
    fingerprint: (v.key.split('::')[1] || '').split('|').filter(Boolean),
    result: `${v.base} · ${v.topLabel || v.base + ' variant'}`,
    resultNote: `Recognised as base type ${v.base}${semantic ? ' (semantic HTML)' : ' (class keyword)'}. Recurs on ${v.pagesFound} page(s).`,
  };
}

(async () => {
  const jobs = [];
  if (cards) jobs.push(['cards-diagram.jpg', recognisedDiagram(cards)]);
  if (unknown) jobs.push(['unknown-diagram.jpg', secondDiagram(unknown, unknown.base === 'unknown')]);
  if (!jobs.length) { console.log('no block variants available for diagrams — skipping'); return; }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-http2'] });
  for (const [key, d] of jobs) {
    const pg = await (await browser.newContext({ viewport: { width: 760, height: 400 }, deviceScaleFactor: 2 })).newPage();
    await pg.setContent(diagramHtml(d), { waitUntil: 'load' });
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(CF, 'shots', key), fullPage: true, type: 'jpeg', quality: 82 });
    console.log('diagram:', key, '←', d.title);
    await pg.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(CF, 'diagrams.json'), JSON.stringify({ a: jobs[0] && jobs[0][0], b: jobs[1] && jobs[1][0] }));
  console.log('done');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
