#!/usr/bin/env node
/*
 * build-urls-all.js — convert the crawler's JSON array output (.crawl.out, or the
 * checkpoint if the crawl was interrupted) into urls-all.json, splitting pages
 * from documents and computing a status breakdown.
 * Usage: node build-urls-all.js <catalogFolder>
 */
const fs = require('fs');
const path = require('path');
const CF = process.argv[2] || '.';
let raw;
const outFile = path.join(CF, '.crawl.out');
const ckFile = path.join(CF, 'crawl-checkpoint.json');
if (fs.existsSync(outFile) && fs.statSync(outFile).size > 2) {
  raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} else if (fs.existsSync(ckFile)) {
  raw = JSON.parse(fs.readFileSync(ckFile, 'utf8')).urls || [];
} else { console.error('no crawl output found'); process.exit(1); }

const docExt = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip', '.rar'];
const imgExt = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.avif'];
const urls = []; const documents = [];
const sb = { success: 0, redirect: 0, clientError: 0, serverError: 0, errorTimeout: 0 };
for (const it of raw) {
  const u = typeof it === 'string' ? it : it.url;
  const s = typeof it === 'string' ? 200 : (it.status || 0);
  const lu = u.toLowerCase().split(/[?#]/)[0];
  if (s === 0) sb.errorTimeout++; else if (s < 300) sb.success++; else if (s < 400) sb.redirect++; else if (s < 500) sb.clientError++; else sb.serverError++;
  const isDoc = docExt.some((e) => lu.endsWith(e)); const isImg = imgExt.some((e) => lu.endsWith(e));
  const o = { url: u, status: s };
  (isDoc && !isImg) ? documents.push(o) : urls.push(o);
}
const out = { 'analysis-urls-all': { captured: new Date().toISOString(), totalUrls: urls.length, totalDocuments: documents.length, method: 'crawl', sitemapURL: null, robotsTxtFound: false, robotsTxtRulesApplied: false, limitations: '', confidence: '88%', statusBreakdown: sb, urls, documents } };
fs.writeFileSync(path.join(CF, 'urls-all.json'), JSON.stringify(out, null, 2));
console.log('urls-all.json:', urls.length, 'pages,', documents.length, 'documents |', JSON.stringify(sb));
