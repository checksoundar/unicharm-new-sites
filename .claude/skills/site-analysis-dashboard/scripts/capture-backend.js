#!/usr/bin/env node
/*
 * capture-backend.js — sample pages and record backend/API calls (XHR + fetch) to
 * infer PROBABLE backend integrations that don't appear as <script>/<iframe> tags.
 *
 * For a representative sample of the render set it navigates with a network listener,
 * collects xhr/fetch request hosts+paths, classifies them (analytics beacons, tag CDPs,
 * identity/auth, consent, logging/telemetry, commerce/pricing, chat, CMS/content, etc.)
 * and writes backend.json consumed by build-dashboard.js.
 *
 * Env: PW_CHROME, SCOPE_UA, SCOPE_DELAY(ms). Args: --sample N (default 60), --concurrency N.
 * Resumable: skips pages already in backend-pages.jsonl.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CF = process.argv[2] || '.';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const SAMPLE = parseInt(arg('--sample', '60'), 10);
const CONCURRENCY = parseInt(arg('--concurrency', '1'), 10);
const DELAY = parseInt(process.env.SCOPE_DELAY || '1500', 10);
const UA = process.env.SCOPE_UA || 'curl/8.5.0';

const renderSet = JSON.parse(fs.readFileSync(path.join(CF, 'render-set.json'), 'utf8')).urls;
// Sample: 1 per URL-pattern group so we exercise diverse page types (home, pricing, product, blog, locale).
function gkey(u) { const p = new URL(u).pathname.split('/').filter(Boolean); return p.length <= 1 ? '/' : '/' + p.slice(0, -1).join('/'); }
const byGroup = {};
for (const u of renderSet) { const k = gkey(u); (byGroup[k] = byGroup[k] || []).push(u); }
let sample = [];
for (const arr of Object.values(byGroup)) sample.push(arr[0]);
// always include high-signal pages if present (site-agnostic): the home page (shortest
// path) + any page whose path hints at conversion/commerce flows (pricing, plans, buy, etc.).
const byLen = renderSet.slice().sort((a, b) => a.length - b.length);
const HI = /(pricing|plans?|buy|checkout|cart|signup|sign-up|get-started|free-trial|contact|demo|subscribe|account)/i;
const musts = [byLen[0]].concat(renderSet.filter((u) => { try { return HI.test(new URL(u).pathname); } catch (e) { return false; } }).slice(0, 5));
for (const m of musts) { if (m && !sample.includes(m)) sample.push(m); }
sample = [...new Set(sample)].slice(0, SAMPLE);

const OUT = path.join(CF, 'backend-pages.jsonl');
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { if (l.trim()) try { done.add(JSON.parse(l).url); } catch (e) {} }
const todo = sample.filter((u) => !done.has(u));
console.error(`Backend sample ${sample.length}, already done ${done.size}, todo ${todo.length}`);

function normPath(p) { return p.replace(/[0-9a-f-]{8,}/gi, ':id').replace(/\d{3,}/g, ':n').replace(/\/+$/, '') || '/'; }

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const stream = fs.createWriteStream(OUT, { flags: 'a' });
  const queue = todo.slice(); let n = 0; let ok = 0; let fail = 0;
  async function worker() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); page.setDefaultTimeout(40000);
    while (queue.length) {
      const url = queue.shift(); n++;
      const calls = new Set();
      const onReq = (req) => {
        const t = req.resourceType();
        if (t !== 'xhr' && t !== 'fetch') return;
        try { const u = new URL(req.url()); calls.add(req.method() + ' ' + u.hostname + normPath(u.pathname)); } catch (e) {}
      };
      page.on('request', onReq);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await page.waitForTimeout(2500); // let deferred XHR/telemetry fire
        try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)); } catch (e) {}
        await page.waitForTimeout(1500);
        stream.write(JSON.stringify({ url, calls: [...calls] }) + '\n'); ok++;
      } catch (e) {
        // still record whatever fired before the error
        stream.write(JSON.stringify({ url, calls: [...calls], err: (e.message || '').split('\n')[0].slice(0, 80) }) + '\n');
        fail += calls.size ? 0 : 1;
        await page.waitForTimeout(3000);
      }
      page.off('request', onReq);
      if (DELAY) await page.waitForTimeout(DELAY);
      if (n % 10 === 0) console.error(`  ${n}/${todo.length} (ok=${ok} empty-fail=${fail})`);
    }
    await ctx.close();
  }
  const ws = []; for (let i = 0; i < CONCURRENCY; i++) ws.push(worker());
  await Promise.all(ws);
  stream.end(); await browser.close();
  console.error(`DONE backend capture. pages=${n} ok=${ok}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
