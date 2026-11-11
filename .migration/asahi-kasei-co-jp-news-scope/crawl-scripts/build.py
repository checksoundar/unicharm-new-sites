"""Build migration-scope artifacts for asahi-kasei.co.jp news 2006-2014 (JP + EN)."""
import json, re, sys, os, collections, datetime
from urllib.parse import urlparse

SRC, DST = sys.argv[1], sys.argv[2]
A = json.load(open(os.path.join(SRC, 'all.json')))
FP = json.load(open(os.path.join(SRC, 'fingerprint.json')))
H = 'https://www.asahi-kasei.co.jp'
YEARS = range(2006, 2015)
IDX = re.compile(r'^/asahi/(jp|en)/news/(20\d\d)/(press\.html|ir\.html|csr\.html)?$')
ART = re.compile(r'^/asahi/(jp|en)/(news|csr/news)/(20\d\d)/[^/]+\.html?$')
DOC = re.compile(r'^/asahi/(jp|en)/(news|csr/news)/(20\d\d)/.+\.(pdf|docx?|xlsx?|pptx?|zip)$', re.I)

def year_ok(y): return 2006 <= int(y) <= 2014

OOS = json.load(open(os.path.join(SRC, 'csr-out-of-scope.json')))
OOS_URLS = {o['url'] for o in OOS}
pages, docs, related, excluded = [], [], [], []
for r in A:
    u = r['url']; p = urlparse(u).path; st = r['status']
    if u in OOS_URLS:
        continue
    title = r.get('title', '')
    m = IDX.match(p)
    if m and year_ok(m.group(2)):
        if st == 200:
            tab = {None: 'all', 'press.html': 'press', 'ir.html': 'ir', 'csr.html': 'csr'}[m.group(3)]
            pages.append(dict(url=u, locale=m.group(1), year=int(m.group(2)), type='news-index', tab=tab, title=title))
        else:
            excluded.append(dict(url=u, status=st, location=r.get('location'), reason='listing tab does not exist (404)' if st == 404 else 'redirect'))
        continue
    m = ART.match(p)
    if m and year_ok(m.group(3)):
        if st == 200 and p.endswith('/index.html'):
            excluded.append(dict(url=u, status=st, reason='duplicate alias of %s' % u[:-len('index.html')]))
        elif st == 200:
            pages.append(dict(url=u, locale=m.group(1), year=int(m.group(3)),
                              type='csr-news-article' if m.group(2) == 'csr/news' else 'news-article', title=title))
        else:
            excluded.append(dict(url=u, status=st, location=r.get('location'),
                                 reason='redirects to %s' % r.get('location') if st in (301, 302) else 'broken link (%s)' % st))
        continue
    m = DOC.match(p)
    if m and year_ok(m.group(3)):
        if st == 200:
            docs.append(dict(url=u, locale=m.group(1), year=int(m.group(3)), type=p.rsplit('.', 1)[1].lower(),
                             sizeBytes=int(r['len']) if r.get('len') else None, linkedFrom=sorted(r.get('from') or [])[:5]))
        else:
            excluded.append(dict(url=u, status=st, reason='broken document link (%s)' % st))
        continue
    # everything else linked from the news section
    if not u.startswith(H + '/asahi/'):
        continue
    if st == 200 and '/sports/' in p and p.endswith('.html'):
        related.append(dict(url=u, title=title, type='sports-result', linkedFrom=sorted(r.get('from') or [])[:3],
                            note='Linked from the FY2007 JP news index; lives outside /news/. Optional.'))
    else:
        excluded.append(dict(url=u, status=st, location=r.get('location'),
                             reason='outside news section; ' + ('redirects to %s' % r.get('location') if st in (301, 302)
                                                                 else 'broken link (%s)' % st if st >= 400 else 'not part of news scope')))

pages.sort(key=lambda x: (x['locale'] != 'jp', x['year'], x['type'] != 'news-index', x['url']))
docs.sort(key=lambda x: (x['locale'] != 'jp', x['year'], x['url']))
excluded.sort(key=lambda x: x['url'])

# breakdowns
bd = collections.defaultdict(lambda: collections.Counter())
for p in pages: bd[(p['locale'], p['year'])][p['type']] += 1
for d in docs: bd[(d['locale'], d['year'])]['pdf'] += 1
by_year = [dict(locale=l, year=y, **{k: bd[(l, y)].get(k, 0) for k in ('news-index', 'news-article', 'csr-news-article', 'pdf')})
           for l in ('jp', 'en') for y in YEARS]
tot = collections.Counter((p['locale'], p['type']) for p in pages)
summary = dict(
    site='https://www.asahi-kasei.co.jp', section='/asahi/{jp,en}/news/2006/ … /2014/ (fiscal years; FY2014 runs Apr 2014–Mar 2015)',
    captured=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), method='crawl',
    crawl=dict(seeds='72 listing URLs (2 locales x 9 years x {index, press, ir, csr})', depth='listing -> article -> article attachments until no new in-scope URL',
               fetched=len(A), sitemap=None, robotsTxt=None, notes='No sitemap.xml/robots.txt on host; directory roots /csr/news/{yyyy}/ return 403 so CSR articles are only discoverable via listing links.'),
    totals=dict(pagesInScope=len(pages), documentsInScope=len(docs), optionalRelatedPages=len(related), excluded=len(excluded), outOfScopeCSR=len(OOS),
                jp=dict(index=tot[('jp', 'news-index')], newsArticles=tot[('jp', 'news-article')], csrArticles=tot[('jp', 'csr-news-article')],
                        pdf=sum(1 for d in docs if d['locale'] == 'jp')),
                en=dict(index=tot[('en', 'news-index')], newsArticles=tot[('en', 'news-article')], csrArticles=tot[('en', 'csr-news-article')],
                        pdf=sum(1 for d in docs if d['locale'] == 'en'))),
    byYear=by_year,
    templates=[
        dict(name='news-index', urls=sum(1 for p in pages if p['type'] == 'news-index'),
             note='Same markup 2006-2014: h1.hdg-l1-01, ul.navi-pagelink-01 tabs, table.tbl-news-01 date/title rows, ul.lyt-image-06 prev/next year. Script: import-index.js. JP CSR tab is out of scope; EN has no CSR tab. Mostly date+title link tables; candidate for an EDS query-index driven list instead of static migration.'),
        dict(name='article-legacy (FY2006-2010)', urls=sum(1 for p in pages if p['type'] != 'news-index' and p['year'] <= 2010),
             note='Layout-table markup: div.innerSection/.subsection (JP) or div.outsideSection (EN), <font class=hdg> or div.newsTitle as title, no <h1>, date and body inside <table>. Needs its own import script (import-article-legacy.js).'),
        dict(name='article-modern (FY2011-2014)', urls=sum(1 for p in pages if p['type'] != 'news-index' and p['year'] >= 2011),
             note='Semantic classes: h1.hdg-l1-03 title, p.ar date, p.text-type-01/02 body, p.lyt-image-01 + span.caption images, div.column2 / div.lyt-block-01 image+text, table.list-other-01 attachment/contact tables, ul.list-notice-01 notes, p.backlink. Script: import-article.js.'),
    ],
    importerNotes=[
        'jp/news/2013/li130801.html is served as UTF-16 while declaring UTF-8: the importer must sniff the BOM before parsing.',
        'EN FY2006–FY2010 article <title>s are generic ("Fiscal 2006 / Press Releases - Asahi Kasei"): take the page title from the article heading, not <title>.',
        'CSR is out of scope (259 URLs, see out-of-scope-csr.json). JP “All” listings and some press releases still link to CSR articles: the listing script must drop those rows (or point them to the CSR content on asahi-kasei.com) so no links break.',
        'Year roots also answer at /index.html (duplicate aliases, excluded). /csr/news/{yyyy}/index.html 301 to /news/{yyyy}/csr.html.',
        'Listing tabs link to many old IR PDFs under /asahi/jp/ir/news/pdf/ and /asahi/en/ir/... that now 404 or 301 to asahi-kasei.com: rewrite or drop these links during import (see excluded.json).',
    ],
    recommendation='Use the EDS Importer (bulk import script over the URL list) rather than EMA page-by-page analysis: ~1,100 near-identical, text-first legacy pages with a single layout; content is static and needs only cleanup (remove global nav/aside/footer, keep title, date, body, tables, images, PDF links).',
    layoutSample=[dict(key=f['k'], url=f['u'], containers=f['ids']) for f in FP],
)
url_groups = []
grp = collections.defaultdict(list)
for p in pages: grp[re.sub(r'/[^/]+\.html?$', '/*', urlparse(p['url']).path).replace('/' + str(p['year']) + '/', '/{yyyy}/')].append(p['url'])
for d in docs: grp[re.sub(r'/[^/]+$', '/*', urlparse(d['url']).path).replace('/' + str(d['year']) + '/', '/{yyyy}/')].append(d['url'])
for k, v in sorted(grp.items(), key=lambda kv: -len(kv[1])): url_groups.append(dict(group=k, count=len(v), urls=v))

os.makedirs(DST, exist_ok=True)
w = lambda n, o: json.dump(o, open(os.path.join(DST, n), 'w'), ensure_ascii=False, indent=2)
w('scope-summary.json', summary)
w('urls-in-scope.json', dict(pages=pages, documents=docs, optionalRelated=related))
w('url-groups.json', url_groups)
w('excluded.json', excluded)
w('out-of-scope-csr.json', dict(decision='CSR pages are out of scope (client sheet of CSR URLs, 259 rows).', urls=OOS))
open(os.path.join(DST, 'out-of-scope-csr.txt'), 'w').write('\n'.join(o['url'] for o in OOS) + '\n')
open(os.path.join(DST, 'import-urls-jp.txt'), 'w').write('\n'.join(p['url'] for p in pages if p['locale'] == 'jp') + '\n')
open(os.path.join(DST, 'import-urls-en.txt'), 'w').write('\n'.join(p['url'] for p in pages if p['locale'] == 'en') + '\n')
open(os.path.join(DST, 'documents.txt'), 'w').write('\n'.join(d['url'] for d in docs) + '\n')
# CSV for spreadsheet review
import csv
with open(os.path.join(DST, 'migration-scope.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    cw = csv.writer(f); cw.writerow(['url', 'locale', 'fiscal_year', 'type', 'tab', 'title', 'in_scope'])
    for p in pages: cw.writerow([p['url'], p['locale'], p['year'], p['type'], p.get('tab', ''), p['title'], 'yes'])
    for d in docs: cw.writerow([d['url'], d['locale'], d['year'], 'document-' + d['type'], '', '', 'yes'])
    for r in related: cw.writerow([r['url'], 'jp', '', r['type'], '', r['title'], 'optional'])
    for e in excluded: cw.writerow([e['url'], '', '', 'excluded', '', e['reason'], 'no'])
    for o in OOS: cw.writerow([o['url'], 'jp', o['fy'], 'out-of-scope: ' + o['kind'], '', o['title'], 'no (CSR out of scope)'])
print(json.dumps(summary['totals'], indent=1))
for r in by_year: print(r)
print('excluded reasons:', collections.Counter(e['reason'].split(' (')[0].split(' to ')[0] for e in excluded))
