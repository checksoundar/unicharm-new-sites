#!/usr/bin/env node
/*
 * validate-dashboard.js — open a built dashboard in headless Chromium, visit every section and
 * report JS errors, section text heads, the classification-table row count and gallery rail.
 * Usage: node validate-dashboard.js <dashboard.html>
 */
const { chromium } = require('playwright-core');
(async () => {
  const file = process.argv[2];
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('file://' + file); await p.waitForTimeout(1200);
  const out = {};
  for (const id of ['overview', 'methodology', 'templates', 'blocks', 'review', 'integrations', 'coverage']) {
    await p.evaluate((i) => { const t = document.querySelector(`[data-view="${i}"],a[href="#${i}"]`); if (t) t.click(); }, id);
    await p.waitForTimeout(400);
    out[id] = await p.evaluate((i) => { const v = document.querySelector('#view-' + i); return v ? v.innerText.replace(/\s+/g, ' ').slice(0, 140) : '(missing)'; }, id);
  }
  await p.evaluate(() => { const t = document.querySelector('[data-view="blocks"],a[href="#blocks"]'); if (t) t.click(); });
  await p.waitForTimeout(400);
  out.classificationRows = await p.evaluate(() => document.querySelectorAll('#aem-body tr').length);
  out.rail = await p.evaluate(() => Array.from(document.querySelectorAll('.type-btn')).map((x) => x.textContent.trim()).join(' | '));
  out.errors = errs;
  console.log(JSON.stringify(out, null, 1));
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
