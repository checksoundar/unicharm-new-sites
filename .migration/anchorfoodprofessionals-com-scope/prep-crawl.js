// Moves AEM Sling component endpoints (_jcr_content/...html) out of the page set and marks
// off-site redirects as 301 so they are not rendered as in-scope pages.
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('.crawl.out', 'utf8'));
const O = 'https://www.anchorfoodprofessionals.com';
const kept = []; const endpoints = [];
for (const r of raw) {
  if (r.url.includes('/_jcr_content/')) { endpoints.push(r); continue; }
  if (r.finalUrl && !r.finalUrl.startsWith(O)) r.status = 301;
  kept.push(r);
}
if (!fs.existsSync('.crawl.raw.json')) fs.writeFileSync('.crawl.raw.json', JSON.stringify(raw, null, 1));
fs.writeFileSync('.crawl.out', JSON.stringify(kept, null, 1));
fs.writeFileSync('aem-endpoints.json', JSON.stringify(endpoints, null, 1));
console.log('kept', kept.length, 'component endpoints', endpoints.length);
