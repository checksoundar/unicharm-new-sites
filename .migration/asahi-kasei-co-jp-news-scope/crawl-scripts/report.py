"""Render the Asahi Kasei news-archive migration scope as one self-contained HTML report."""
import json, sys, os, base64, html, collections, datetime

SCOPE, RAW, LOGO, OUT = sys.argv[1:5]
S = json.load(open(os.path.join(SCOPE, 'scope-summary.json')))
U = json.load(open(os.path.join(SCOPE, 'urls-in-scope.json')))
X = json.load(open(os.path.join(SCOPE, 'excluded.json')))
RAWD = {r['url']: r for r in json.load(open(RAW))}
logo64 = base64.b64encode(open(LOGO, 'rb').read()).decode()
esc = html.escape
H = 'https://www.asahi-kasei.co.jp'

# ---------- derive rows ----------
def category(p):
    if p['type'] == 'news-index':
        return {'all': 'All', 'press': 'Press', 'ir': 'IR', 'csr': 'CSR'}[p['tab']]
    f = RAWD.get(p['url'], {}).get('from') or []
    cats = sorted({x.rsplit('/', 1)[1][:-5] for x in f if x.endswith(('press.html', 'ir.html', 'csr.html'))})
    if not cats and p['type'] == 'csr-news-article':
        cats = ['csr']
    return ' + '.join(c.upper() if c != 'press' else 'Press' for c in cats) or 'Notice'

def template(p):
    if p['type'] == 'news-index': return 'Listing'
    return 'Legacy article' if p['year'] <= 2010 else 'Modern article'

pages = [dict(u=p['url'][len(H):], l=p['locale'].upper(), y=p['year'], t=template(p), c=category(p), n=p['title']) for p in U['pages']]
docs = [dict(u=d['url'][len(H):], l=d['locale'].upper(), y=d['year'], k=round((d['sizeBytes'] or 0) / 1024), f=(d['linkedFrom'] or [''])[0][len(H):]) for d in U['documents']]
opt = [dict(u=r['url'][len(H):], n=r['title'], f=(r['linkedFrom'] or [''])[0][len(H):]) for r in U['optionalRelated']]
exc = [dict(u=e['url'].replace(H, ''), s=e['status'], r=e['reason'].replace(H, '')) for e in X]

T = S['totals']
n_pages, n_docs, n_opt, n_exc = T['pagesInScope'], T['documentsInScope'], T['optionalRelatedPages'], T['excluded']
jp_pages = T['jp']['index'] + T['jp']['newsArticles'] + T['jp']['csrArticles']
en_pages = T['en']['index'] + T['en']['newsArticles']
tpl = collections.Counter(p['t'] for p in pages)
tpl_loc = collections.Counter((p['t'], p['l']) for p in pages)
cat = collections.Counter(p['c'] for p in pages if p['t'] != 'Listing')
pdf_mb = sum(d['sizeBytes'] or 0 for d in U['documents']) / 1e6
fetched = S['crawl']['fetched']
exc_reason = collections.Counter()
for e in X:
    r = e['reason']
    if r.startswith('outside news section; broken'): exc_reason['Broken link outside the news section (mostly old IR PDFs)'] += 1
    elif r.startswith('outside news section; redirects'): exc_reason['Redirects to asahi-kasei.com (already on the new site)'] += 1
    elif r.startswith('listing tab'): exc_reason['EN “CSR” listing tab — does not exist'] += 1
    elif r.startswith('duplicate'): exc_reason['Duplicate /index.html alias of a year listing'] += 1
    elif r.startswith('redirects'): exc_reason['Old CSR year index — redirects to the CSR tab'] += 1
    else: exc_reason['Broken link inside the news section'] += 1

by_year = [dict(y=r['year'], jpn=r['news-article'], jpc=r['csr-news-article'], idx=r['news-index'], pdf=r['pdf'])
           for r in S['byYear'] if r['locale'] == 'jp']
for r, e in zip(by_year, [r for r in S['byYear'] if r['locale'] == 'en']):
    r['enn'] = e['news-article']; r['enidx'] = e['news-index']; r['enpdf'] = e['pdf']

def sample(tname, loc, k=3):
    return [p['u'] for p in pages if p['t'] == tname and p['l'] == loc][::97][:k]

today = datetime.date.today().strftime('%-d %B %Y')
data = dict(pages=pages, docs=docs, opt=opt, exc=exc, years=by_year)

# ---------- content blocks ----------
def tiles():
    items = [
        ('Pages to import', f'{n_pages:,}', f'JP {jp_pages:,} · EN {en_pages:,}'),
        ('PDF attachments', f'{n_docs:,}', f'{pdf_mb:.1f} MB in total'),
        ('Import scripts', '3', 'listing · modern · legacy'),
        ('Excluded links', f'{n_exc}', 'broken or already redirected'),
    ]
    return ''.join(f'<div class="tile"><div class="tile-label">{a}</div><div class="tile-value">{b}</div><div class="tile-sub">{c}</div></div>' for a, b, c in items)

def tbl(head, rows, cls=''):
    th = ''.join(f'<th>{h}</th>' for h in head)
    tr = ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows)
    return f'<div class="tbl-wrap"><table class="tbl {cls}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></div>'

def link(path, label=None):
    return f'<a href="{H}{esc(path)}" target="_blank" rel="noopener">{esc(label or path)}</a>'

ok, todo, part = '<span class="badge good">✓ Done</span>', '<span class="badge todo">○ To do</span>', '<span class="badge part">◐ Proposed</span>'

TEMPLATES = [
    dict(key='listing', name='Listing', script='import-index.js', count=tpl['Listing'], years='FY2006–FY2014',
         split=f"JP {tpl_loc[('Listing','JP')]} · EN {tpl_loc[('Listing','EN')]}",
         desc='The year listing and its Press / IR / CSR tabs. The markup is the same in every year.',
         sig=['h1.hdg-l1-01 page title', 'ul.navi-pagelink-01 tab bar (All · Press · IR · CSR)', 'table.tbl-news-01 rows: date | title link | PDF icon', 'ul.lyt-image-06 previous / next year links'],
         wire=['h1', 'tabs', 'rows', 'rows', 'rows', 'rows', 'pager'],
         samples=sample('Listing', 'JP', 2) + sample('Listing', 'EN', 1), difficulty='Low'),
    dict(key='modern', name='Modern article', script='import-article.js', count=tpl['Modern article'], years='FY2011–FY2014',
         split=f"JP {tpl_loc[('Modern article','JP')]} · EN {tpl_loc[('Modern article','EN')]}",
         desc='Clean, class-based markup: a real title heading, a date line, body paragraphs, captioned images, image-and-text columns and attachment tables.',
         sig=['h1.hdg-l1-03 title · p.ar date', 'p.text-type-01 / -02 body paragraphs', 'p.lyt-image-01 + span.caption images', 'div.column2 · div.lyt-block-01 .imageR image + text', 'table.list-other-01 attachments / contacts', 'ul.list-notice-01 notes · p.backlink'],
         wire=['h1', 'date', 'text', 'img', 'cols', 'text', 'table'],
         samples=sample('Modern article', 'JP', 2) + sample('Modern article', 'EN', 1), difficulty='Medium'),
    dict(key='legacy', name='Legacy article', script='import-article-legacy.js', count=tpl['Legacy article'], years='FY2006–FY2010',
         split=f"JP {tpl_loc[('Legacy article','JP')]} · EN {tpl_loc[('Legacy article','EN')]}",
         desc='Older layout-table markup with &lt;font&gt; tags and no real title heading. Japanese and English use different wrappers. This group needs the most cleanup.',
         sig=['JP: div.innerSection › div.subsection', 'EN: div.outsideSection › div.innerSection', 'title in &lt;font class="hdg"&gt; or div.newsTitle — no &lt;h1&gt;', 'date and body inside layout &lt;table&gt; cells', '&lt;font&gt; styling everywhere', 'a.backlink / p.text-link-01 back links'],
         wire=['tbl', 'h1?', 'tbl', 'text', 'img', 'tbl', 'text'],
         samples=sample('Legacy article', 'JP', 2) + sample('Legacy article', 'EN', 1), difficulty='High'),
]

def wire(parts):
    m = {'h1': ('Title', 'w-h1'), 'h1?': ('Title (font tag)', 'w-h1 w-warn'), 'tabs': ('All · Press · IR · CSR', 'w-tabs'), 'rows': ('date — headline', 'w-row'),
         'pager': ('‹ previous year · next year ›', 'w-pager'), 'date': ('date', 'w-date'), 'text': ('', 'w-text'), 'img': ('image + caption', 'w-img'),
         'cols': ('image | text', 'w-cols'), 'table': ('attachments table', 'w-table'), 'tbl': ('layout table', 'w-tbl')}
    return '<div class="wire"><div class="wire-shell">header · global nav</div><div class="wire-body"><div class="wire-main">' + \
        ''.join(f'<div class="w {m[p][1]}">{m[p][0]}</div>' for p in parts) + \
        '</div><div class="wire-aside">side column</div></div><div class="wire-shell">footer</div></div>'

def template_cards():
    out = []
    for t in TEMPLATES:
        sig = ''.join(f'<li><code>{s}</code></li>' for s in t['sig'])
        sm = ''.join(f'<li>{link(u)}</li>' for u in t['samples'])
        out.append(f'''<article class="tcard" id="tpl-{t['key']}">
  <div class="tcard-head"><div><h3>{t['name']}</h3><div class="muted">{t['years']} · {t['split']}</div></div>
  <div class="tcard-count"><span>{t['count']:,}</span>pages</div></div>
  <div class="tcard-grid">{wire(t['wire'])}
   <div><p>{t['desc']}</p>
    <div class="kv"><span>Script</span><code>{t['script']}</code></div>
    <div class="kv"><span>Difficulty</span><span class="diff diff-{t['difficulty'].lower()}">{t['difficulty']}</span></div>
    <h4>Markup signature</h4><ul class="sig">{sig}</ul>
    <h4>Pages to test in the Workbench</h4><ul class="samples">{sm}</ul></div></div></article>''')
    return ''.join(out)

MAPPING = [
    ('Listing', 'h1.hdg-l1-01', 'Heading 1', 'Default content'),
    ('Listing', 'ul.navi-pagelink-01 tab bar', 'news-list filter / section links', part),
    ('Listing', 'table.tbl-news-01 rows', '<b>news-list</b> block (date · category · title)', part),
    ('Listing', 'ul.lyt-image-06 prev / next year', 'Removed — year selector in news-list', 'Removed'),
    ('Article', 'h1.hdg-l1-03 · font.hdg · div.newsTitle', '<b>article-header</b> block (title + date)', part),
    ('Article', 'p.ar date line', 'article-header date + <code>publication-date</code> metadata', part),
    ('Article', 'p.text-type-*, lists, em, sup/sub', 'Paragraphs, lists, inline formatting', 'Default content'),
    ('Article', 'p.lyt-image-01 + span.caption', 'Image + <b>caption</b>', part),
    ('Article', 'div.column2 · div.lyt-block-01 .imageR', '<b>columns</b> block', 'Library block'),
    ('Article', 'table.list-other-01 · table.tbl-03', '<b>table</b> block (attachments, contacts, data)', 'Library block'),
    ('Article', 'Legacy layout &lt;table&gt; / &lt;font&gt;', 'Unwrapped to default content', 'Cleanup'),
    ('Article', 'p.backlink · a.backlink · hr', 'Removed', 'Removed'),
    ('All', 'header · global nav · side column · footer', 'Removed — shared nav / footer fragments', 'Removed'),
    ('All', '&lt;title&gt;, locale, fiscal year, tab', '<b>metadata</b> block: title, description, locale, fiscal-year, category, template', 'Metadata'),
]

EFFORT = [
    ('Source content analysis', '2–4 h', '~2 h', 'Crawl, URL list and template grouping are already done; block definitions are left.'),
    ('Block transformations', '~20 h', '24–28 h', 'Three scripts: listing ~4 h, modern article ~9–10 h, legacy article ~11–14 h.'),
    ('Testing / debugging', '6–10 h', '8–12 h', 'Two languages, UTF-16 page, generic EN titles, 173 dead or redirected links.'),
    ('Client feedback & tweaking', '~5 h', '~5 h', 'Same as the deck.'),
]

RISKS = [
    ('high', 'Legacy markup (FY2006–2010)', f'{tpl["Legacy article"]} pages use layout tables and &lt;font&gt; tags with no real title heading. The script has to build the heading and date itself.', 'Separate legacy script; test JP and EN samples from every year in the Workbench.'),
    ('medium', 'Dead and redirected links', f'{n_exc} linked URLs are broken (mostly old IR PDFs) or redirect to asahi-kasei.com.', 'Rewrite redirects to their target and unlink or flag broken ones. Report them in the import Excel.'),
    ('medium', 'Generic EN titles', 'EN FY2006–2010 articles all share a &lt;title&gt; such as “Fiscal 2006 / Press Releases”.', 'Take the page title from the article heading, never from &lt;title&gt;.'),
    ('medium', 'Wrong text encoding', '<code>/asahi/jp/news/2013/li130801.html</code> is UTF-16 but declares UTF-8.', 'Detect the byte-order mark before parsing. Check the Japanese text after import.'),
    ('low', 'CSR folders are locked', '<code>/csr/news/{yyyy}/</code> returns 403, so CSR articles can only be found through listing links.', 'The URL list already covers them. Re-crawl if the listings change.'),
    ('low', 'Duplicate aliases', 'Year listings also answer at <code>/index.html</code>; old CSR year indexes redirect to the CSR tab.', 'Excluded from the import. Add redirects in the EDS redirects sheet.'),
    ('low', 'Links to the new domain', 'Internal links point to www.asahi-kasei.co.jp.', 'Rewrite to the EDS paths (deck tip, slide 19).'),
]

FIT = [
    (True, 'High volume of content in HTML', f'{n_pages:,} pages + {n_docs} PDFs (SoftBank case: ~700 pages)'),
    (True, 'Faster to script than to migrate by hand', f'~{n_pages / 45:.0f} pages per hour of importer work vs. manual copy-paste'),
    (True, 'Content follows machine-identifiable patterns', '3 DOM patterns with stable CSS classes'),
    (True, 'Static content, no APIs or CORS', 'Pages render without JavaScript (deck pitfall does not apply)'),
    (False, 'Only a few pages (~50)', 'Not the case'),
    (False, 'Inconsistent source pages', 'Not the case: the legacy markup is old but consistent'),
]

PREREQ = [
    ('URL list covering all patterns / sitemap', ok, f'{n_pages:,} pages, {n_docs} PDFs, {n_opt} optional, {n_exc} excluded. No sitemap exists, so the list was built by crawling.'),
    ('Content grouped by template', ok, 'Listing · Modern article · Legacy article'),
    ('Block list and auto-block rules decided', part, 'Proposed below: article-header, news-list, caption, columns, table, metadata'),
    ('Block table structure confirmed', todo, 'Confirm with the client before writing parsers'),
    ('Mapping of source content to blocks', part, 'Draft mapping below'),
    ('Output format', ok, 'This project uses Document Authoring, so use “Save for DA” / HTML (not .docx)'),
]

DELIVER = [
    ('import-urls-jp.txt', f'{jp_pages:,} JP page URLs, one per line, for the Bulk importer'),
    ('import-urls-en.txt', f'{en_pages:,} EN page URLs'),
    ('documents.txt', f'{n_docs} PDF attachment URLs'),
    ('migration-scope.csv', 'Every URL with locale, fiscal year, type, title and in-scope flag (opens in Excel)'),
    ('scope-summary.json', 'Totals, per-year counts, templates, importer notes'),
    ('url-groups.json', 'URLs grouped by path pattern'),
    ('excluded.json', 'Every excluded URL with status and reason'),
    ('inner-patterns.json', 'Markup patterns sampled inside the article body'),
    ('crawl-raw.json · crawl-scripts/', 'Raw crawl results and the scripts to re-run it'),
]

STEPS = [
    ('72', 'listing URLs seeded', '2 languages × 9 fiscal years × 4 tabs'),
    ('63', 'listings live', 'EN has no CSR tab (9 × 404)'),
    ('1,316', 'linked URLs checked', 'status, type and title captured'),
    ('156', 'more from articles', 'attachments, sub-pages; second pass found no more'),
    (f'{fetched:,}', 'URLs classified', 'in scope · optional · excluded'),
    ('48', 'pages fingerprinted', 'shell + body markup sampled per year'),
]

NEXT = [
    ('Confirm blocks', 'Agree the block list and table structures with the client (article-header, news-list, caption, columns, table, metadata).'),
    ('Workbench prototypes', 'Build the three scripts against the sample pages above, then tune them in the Workbench.'),
    ('Bulk import', 'Run the JP and EN URL lists through the Bulk importer and export the Excel report.'),
    ('Validate & fix', 'Check the report for edge cases (empty titles, broken links, encoding) and re-run the affected pages.'),
    ('Upload & preview', 'Upload to Document Authoring, add redirects, then preview on Edge Delivery.'),
]

def numbered(items):
    return ''.join(f'<li><b>{a}</b><span>{b}</span></li>' for a, b in items)

exc_rows = [(esc(k), f'{v:,}') for k, v in exc_reason.most_common()]
cat_rows = sorted(cat.items(), key=lambda kv: -kv[1])

CSS = r'''
:root{--adobe-red:#eb1000;--bg:#f8f8f8;--surface:#fff;--surface-2:#f3f3f3;--border:#e1e1e1;--border-2:#cacaca;--text:#222;--text-2:#505050;--muted:#6e6e6e;--accent:#1473e6;--accent-d:#0d66d0;
--good:#12805c;--good-bg:#e6f4ee;--warn:#b35c00;--warn-bg:#fdf1e3;--crit:#c9252d;--crit-bg:#fbe9ea;--info-bg:#e9f1fd;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--grid:#ececec;--radius:8px;--font:"adobe-clean","Adobe Clean","Source Sans 3","Source Sans Pro",-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:76px}
body{margin:0;font-family:var(--font);font-size:15px;line-height:1.55;color:var(--text);background:var(--bg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font-family:"Source Code Pro",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:0 4px;word-break:break-word}
.topbar{position:sticky;top:0;z-index:20;height:60px;display:flex;align-items:center;gap:16px;padding:0 24px;background:#fff;border-bottom:1px solid var(--border)}
.topbar img{height:22px;display:block}.topbar .sep{width:1px;height:24px;background:var(--border-2)}
.topbar .prod{font-weight:700;font-size:15px}.topbar .proj{color:var(--muted);font-size:14px}
.topbar .date{margin-left:auto;font-size:13px;color:var(--muted)}
.topbar .menu{display:none;margin-left:auto;border:1px solid var(--border-2);background:#fff;border-radius:16px;padding:4px 12px;font:inherit;cursor:pointer}
.layout{display:grid;grid-template-columns:248px minmax(0,1fr);max-width:1440px;margin:0 auto}
nav.side{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow:auto;padding:24px 12px 24px 20px;border-right:1px solid var(--border);background:var(--bg)}
nav.side .grp{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 10px 6px}
nav.side a{display:block;padding:6px 10px;border-radius:6px;color:var(--text-2);font-size:14px;border-left:3px solid transparent}
nav.side a:hover{background:#ececec;text-decoration:none}nav.side a.on{background:#fff;color:var(--text);font-weight:700;border-left-color:var(--adobe-red)}
main{padding:32px 40px 80px;min-width:0}
.hero{background:linear-gradient(120deg,#1a1a1a 0%,#2c2c2c 60%,#3a1410 100%);color:#fff;border-radius:12px;padding:36px 40px;position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;right:-60px;top:-60px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(235,16,0,.55),rgba(235,16,0,0) 70%)}
.hero .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#ff8a7a;font-weight:700}
.hero h1{margin:8px 0 10px;font-size:32px;line-height:1.2;font-weight:800;max-width:820px}
.hero p{margin:0;color:#d6d6d6;max-width:820px;font-size:16px}
.hero .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.hero .chip{border:1px solid rgba(255,255,255,.25);border-radius:14px;padding:3px 12px;font-size:13px;color:#eee}
.hero .chip a{color:#fff}
section{margin-top:44px}
section>h2{font-size:24px;font-weight:800;margin:0 0 4px;display:flex;align-items:center;gap:10px}
section>h2 .num{font-size:12px;font-weight:700;color:#fff;background:var(--adobe-red);border-radius:4px;padding:2px 7px}
section>.lead{color:var(--text-2);margin:0 0 18px;max-width:900px}
h3{font-size:18px;margin:0}h4{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:16px 0 6px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:20px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;border-top:3px solid var(--adobe-red)}
.tile-label{font-size:13px;color:var(--text-2)}.tile-value{font-size:30px;font-weight:700;line-height:1.2;margin:4px 0 2px}.tile-sub{font-size:13px;color:var(--muted)}
.callout{display:flex;gap:14px;align-items:flex-start;background:var(--info-bg);border:1px solid #c6dafa;border-radius:var(--radius);padding:16px 18px;margin-top:16px}
.callout .ic{flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700}
.callout.good{background:var(--good-bg);border-color:#b7e0cd}.callout.good .ic{background:var(--good)}
.tbl-wrap{overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:#fff}
table.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{position:sticky;top:0;background:#fafafa;text-align:left;font-size:12px;font-weight:700;color:var(--text-2);padding:10px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:9px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top}.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr:hover td{background:#fafcff}.tbl td.n,.tbl th.n{text-align:right;font-variant-numeric:tabular-nums}
.tbl.compact td:not(:first-child),.tbl.compact th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
.tbl tfoot td{font-weight:700;background:#fafafa;border-top:1px solid var(--border)}
.badge{display:inline-block;font-size:12px;font-weight:700;border-radius:10px;padding:1px 9px;white-space:nowrap}
.badge.good{background:var(--good-bg);color:var(--good)}.badge.todo{background:#eee;color:#555}.badge.part{background:var(--info-bg);color:var(--accent-d)}
.pill{display:inline-block;font-size:12px;border:1px solid var(--border-2);border-radius:10px;padding:0 8px;color:var(--text-2);white-space:nowrap}
.flow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;counter-reset:s}
.flow .st{position:relative;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-right:18px}
.flow .st:not(:last-child):after{content:"";position:absolute;right:-15px;top:50%;width:10px;height:10px;border-top:2px solid var(--border-2);border-right:2px solid var(--border-2);transform:translateY(-50%) rotate(45deg)}
.flow .st b{display:block;font-size:24px}.flow .st span{display:block;font-weight:700;font-size:13px}.flow .st small{display:block;color:var(--muted);font-size:12px;margin-top:4px}
.segbar{display:flex;gap:2px;height:28px;margin:14px 0 8px}
.segbar div{border-radius:4px;color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;padding-left:10px;white-space:nowrap;overflow:hidden;cursor:default}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--text-2)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.chart-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.seg-toggle{display:inline-flex;border:1px solid var(--border-2);border-radius:16px;overflow:hidden}
.seg-toggle button{font:inherit;font-size:13px;border:0;background:#fff;padding:4px 14px;cursor:pointer;color:var(--text-2)}
.seg-toggle button.on{background:var(--text);color:#fff}
#chart{position:relative}#chart svg{display:block;width:100%;height:auto}
#tip{position:absolute;pointer-events:none;background:#fff;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:6px;padding:8px 10px;font-size:13px;opacity:0;transition:opacity .1s;min-width:170px}
#tip .r{display:flex;justify-content:space-between;gap:12px}#tip i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.tcard{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:16px}
.tcard-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:14px}
.tcard-count{text-align:right;color:var(--muted);font-size:12px}.tcard-count span{display:block;font-size:28px;font-weight:700;color:var(--text);line-height:1}
.tcard-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:22px}.tcard p{margin:0 0 10px}
.kv{display:flex;gap:10px;align-items:center;font-size:14px;margin:4px 0}.kv>span:first-child{width:80px;color:var(--muted)}
.diff{font-weight:700;font-size:12px;border-radius:10px;padding:1px 9px}.diff-low{background:var(--good-bg);color:var(--good)}.diff-medium{background:var(--warn-bg);color:var(--warn)}.diff-high{background:var(--crit-bg);color:var(--crit)}
ul.sig,ul.samples{margin:0;padding-left:18px;font-size:13.5px}ul.samples a{word-break:break-all}
.wire{border:1px solid var(--border-2);border-radius:6px;background:#fafafa;padding:6px;font-size:10.5px;color:#666;align-self:start}
.wire-shell{background:#e3e3e3;border-radius:3px;padding:4px;text-align:center}.wire-body{display:flex;gap:6px;margin:6px 0}
.wire-main{flex:1;display:flex;flex-direction:column;gap:4px}.wire-aside{width:52px;background:#ececec;border-radius:3px;display:grid;place-items:center;writing-mode:vertical-rl;font-size:10px}
.w{border-radius:3px;padding:4px 6px;background:#fff;border:1px solid #ddd;min-height:18px}
.w-h1{font-weight:700;font-size:12px;color:#222;border-left:3px solid var(--adobe-red)}.w-warn{border-left-color:var(--warn);font-style:italic}
.w-tabs{background:#e9f1fd;border-color:#c6dafa;color:var(--accent-d)}.w-row{border-style:dashed}.w-pager{text-align:center}
.w-date{width:40%;align-self:flex-end;text-align:right}.w-text{background:repeating-linear-gradient(#fff 0 6px,#e8e8e8 6px 8px);height:30px}
.w-img{height:42px;background:#dfe8f3;display:grid;place-items:center}.w-cols{display:grid;place-items:center;background:linear-gradient(90deg,#dfe8f3 0 45%,#fff 45%)}
.w-table{background:repeating-linear-gradient(#fff 0 9px,#e8e8e8 9px 10px);height:30px;color:#444}.w-tbl{border:1px dashed var(--warn);background:#fdf6ee;color:var(--warn);text-align:center}
.fit{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.fit .f{display:flex;gap:12px;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.fit .f .m{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#fff}
.fit .yes .m{background:var(--good)}.fit .no .m{background:#9a9a9a}.fit .f b{display:block}.fit .f small{color:var(--muted)}
.bars{display:flex;flex-direction:column;gap:10px}
.brow{display:grid;grid-template-columns:170px minmax(0,1fr) 120px;gap:12px;align-items:center;font-size:14px}
.btrack{position:relative;height:22px}.bbase,.bplan{position:absolute;left:0;height:9px;border-radius:0 4px 4px 0}
.bbase{top:0;background:#b9b9b9}.bplan{top:12px;background:var(--s1)}
.risk{display:grid;grid-template-columns:92px minmax(0,1.1fr) minmax(0,1fr);gap:0;background:#fff;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:10px}
.risk>div{padding:12px 14px}.risk .lvl{font-weight:700;font-size:12px;text-transform:uppercase;display:flex;align-items:center;gap:6px}
.risk.high .lvl{background:var(--crit-bg);color:var(--crit)}.risk.medium .lvl{background:var(--warn-bg);color:var(--warn)}.risk.low .lvl{background:#f1f1f1;color:#555}
.risk .mit{background:#fbfbfb;border-left:1px solid var(--border);font-size:14px}.risk .mit b{display:block;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.risk h5{margin:0 0 2px;font-size:15px}.risk p{margin:0;font-size:14px;color:var(--text-2)}
ol.steps{list-style:none;counter-reset:n;padding:0;margin:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
ol.steps li{counter-increment:n;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:14px}
ol.steps li:before{content:counter(n);display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--adobe-red);color:#fff;font-weight:700;font-size:13px;margin-bottom:8px}
ol.steps b{display:block}ol.steps span{font-size:13.5px;color:var(--text-2)}
.inv-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:12px;flex-wrap:wrap}
.inv-tabs button{font:inherit;font-size:14px;border:0;background:none;padding:8px 14px;cursor:pointer;color:var(--text-2);border-bottom:3px solid transparent;margin-bottom:-1px}
.inv-tabs button.on{color:var(--text);font-weight:700;border-bottom-color:var(--adobe-red)}.inv-tabs button em{font-style:normal;color:var(--muted);font-weight:400;margin-left:4px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.filters input,.filters select{font:inherit;font-size:14px;border:1px solid var(--border-2);border-radius:4px;padding:6px 10px;background:#fff}
.filters input{flex:1;min-width:220px}.filters .count{font-size:13px;color:var(--muted);margin-left:auto}
.btn{font:inherit;font-size:14px;font-weight:700;border-radius:16px;padding:5px 14px;cursor:pointer;border:2px solid var(--text);background:#fff;color:var(--text)}
.btn:hover{background:var(--text);color:#fff}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:var(--accent-d)}
#inv td.u{word-break:break-all;font-size:13px}#inv td.t{font-size:13.5px}
.pager{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:10px;font-size:13px;color:var(--muted)}
.files{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.files .card{padding:14px 16px}.files code{font-size:13px}.files p{margin:6px 0 0;font-size:13.5px;color:var(--text-2)}
footer.foot{margin-top:56px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:13px;display:flex;gap:12px;align-items:center}
footer.foot img{height:14px}
.muted{color:var(--muted);font-size:13px}
@media (max-width:1100px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.flow{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:12px}.files,.grid3{grid-template-columns:1fr 1fr}ol.steps{grid-template-columns:1fr 1fr}}
@media (max-width:860px){.layout{grid-template-columns:1fr}nav.side{display:none;position:fixed;top:60px;left:0;width:260px;z-index:30;box-shadow:4px 0 20px rgba(0,0,0,.15)}nav.side.open{display:block}
.topbar .menu{display:block}.topbar .date{display:none}main{padding:20px}.grid2,.fit,.tcard-grid,.files,.grid3{grid-template-columns:1fr}.risk{grid-template-columns:1fr}.risk .mit{border-left:0;border-top:1px solid var(--border)}.brow{grid-template-columns:1fr}.hero{padding:26px}}
@media print{.topbar,nav.side,.filters,.pager,.inv-tabs,.seg-toggle{display:none!important}.layout{display:block}main{padding:0}section{break-inside:avoid-page}}
'''

JS = r'''
const D=JSON.parse(document.getElementById('data').textContent);
const fmt=n=>n.toLocaleString('en-US');
/* ---- scroll spy + mobile menu ---- */
const links=[...document.querySelectorAll('nav.side a')];const secs=links.map(a=>document.querySelector(a.getAttribute('href')));
const spy=()=>{let i=0;secs.forEach((s,k)=>{if(s&&s.getBoundingClientRect().top<120)i=k});links.forEach((a,k)=>a.classList.toggle('on',k===i))};
addEventListener('scroll',spy,{passive:true});spy();
document.querySelector('.menu').onclick=()=>document.querySelector('nav.side').classList.toggle('open');
links.forEach(a=>a.addEventListener('click',()=>document.querySelector('nav.side').classList.remove('open')));
/* ---- stacked column chart ---- */
const SER=[{k:'jpn',n:'JP press & IR articles',c:'var(--s1)'},{k:'jpc',n:'JP CSR articles',c:'var(--s2)'},{k:'enn',n:'EN articles',c:'var(--s3)'}];
function drawChart(){
  const host=document.getElementById('chart');const W=920,H=300,m={l:44,r:12,t:20,b:36};
  const Y=D.years;const tot=Y.map(y=>SER.reduce((a,s)=>a+y[s.k],0));const max=Math.ceil(Math.max(...tot)/40)*40;
  const iw=W-m.l-m.r,ih=H-m.t-m.b,band=iw/Y.length,bw=Math.min(24,band*.5);
  const y=v=>m.t+ih-(v/max)*ih;let g='';
  for(let v=0;v<=max;v+=40){g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.l-8}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${v}</text>`}
  Y.forEach((d,i)=>{const x=m.l+band*i+(band-bw)/2;let acc=0;
    SER.forEach((s,si)=>{const v=d[s.k];if(!v)return;const y0=y(acc),y1=y(acc+v);acc+=v;const top=si===SER.length-1||SER.slice(si+1).every(t=>!d[t.k]);
      const h=Math.max(0,y0-y1-(acc-v>0?2:0));const yy=y1;
      g+= top?`<path d="M${x},${yy+h} V${yy+4} Q${x},${yy} ${x+4},${yy} H${x+bw-4} Q${x+bw},${yy} ${x+bw},${yy+4} V${yy+h} Z" fill="${s.c}"/>`
             :`<rect x="${x}" y="${yy}" width="${bw}" height="${h}" fill="${s.c}"/>`});
    g+=`<text x="${x+bw/2}" y="${y(tot[i])-6}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${tot[i]}</text>`;
    g+=`<text x="${x+bw/2}" y="${H-m.b+18}" text-anchor="middle" font-size="12" fill="var(--text-2)">FY${d.y}</text>`;
    g+=`<rect class="hit" data-i="${i}" x="${m.l+band*i}" y="${m.t}" width="${band}" height="${ih}" fill="transparent"/>`});
  g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border-2)"/>`;
  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Articles to import per fiscal year, stacked by JP press and IR, JP CSR and EN">${g}</svg><div id="tip"></div>`;
  const tip=host.querySelector('#tip');
  host.querySelectorAll('.hit').forEach(r=>{r.addEventListener('mousemove',e=>{const d=Y[+r.dataset.i];const b=host.getBoundingClientRect();
    tip.innerHTML=`<b>Fiscal ${d.y}</b> <span class="muted">(Apr ${d.y} – Mar ${d.y+1})</span>`+SER.map(s=>`<div class="r"><span><i style="background:${s.c}"></i>${s.n}</span><b>${d[s.k]}</b></div>`).join('')+
      `<div class="r" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Articles</span><b>${tot[+r.dataset.i]}</b></div><div class="r muted"><span>PDFs (JP / EN)</span><span>${d.pdf} / ${d.enpdf}</span></div>`;
    tip.style.opacity=1;let lx=e.clientX-b.left+14;if(lx>b.width-200)lx=e.clientX-b.left-200;tip.style.left=lx+'px';tip.style.top=(e.clientY-b.top-20)+'px'});
    r.addEventListener('mouseleave',()=>tip.style.opacity=0)});
}
drawChart();
document.querySelectorAll('.seg-toggle button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.seg-toggle button').forEach(x=>x.classList.toggle('on',x===b));
  document.getElementById('chart').hidden=b.dataset.v!=='chart';document.querySelector('.chart-legend').hidden=b.dataset.v!=='chart';document.getElementById('yeartable').hidden=b.dataset.v!=='table'});
/* ---- inventory ---- */
const COLS={pages:[['u','URL'],['l','Lang'],['y','FY'],['t','Template'],['c','Category'],['n','Page title']],
  docs:[['u','PDF URL'],['l','Lang'],['y','FY'],['k','KB'],['f','Linked from']],
  opt:[['u','URL'],['n','Page title'],['f','Linked from']],exc:[['u','URL'],['s','Status'],['r','Reason']]};
let cur='pages',page=0;const PER=50;const H0='https://www.asahi-kasei.co.jp';
const q=document.getElementById('q'),fl=document.getElementById('fl'),fy=document.getElementById('fy'),ft=document.getElementById('ft');
function rows(){const s=q.value.trim().toLowerCase();return D[cur].filter(r=>(!s||Object.values(r).join(' ').toLowerCase().includes(s))&&(!fl.value||r.l===fl.value)&&(!fy.value||String(r.y)===fy.value)&&(!ft.value||r.t===ft.value))}
function cell(r,k){const v=r[k]??'';if(k==='u'||k==='f'){if(!v)return'';const href=v.startsWith('http')?v:H0+v;return `<a href="${href}" target="_blank" rel="noopener">${v.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</a>`}
  if(k==='t')return `<span class="pill">${v}</span>`;if(k==='s')return `<span class="pill">${v}</span>`;return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function render(){const R=rows();const pages=Math.max(1,Math.ceil(R.length/PER));page=Math.min(page,pages-1);
  const cols=COLS[cur];const cls=k=>k==='u'||k==='f'?'u':(k==='y'||k==='k'?'n':(k==='n'||k==='r'?'t':''));
  document.querySelector('#inv thead').innerHTML='<tr>'+cols.map(([k,n])=>`<th class="${cls(k)}">${n}</th>`).join('')+'</tr>';
  document.querySelector('#inv tbody').innerHTML=R.slice(page*PER,page*PER+PER).map(r=>'<tr>'+cols.map(([k])=>`<td class="${cls(k)}">${cell(r,k)}</td>`).join('')+'</tr>').join('')||`<tr><td colspan="${cols.length}" class="muted">No URLs match these filters.</td></tr>`;
  document.getElementById('cnt').textContent=`${fmt(R.length)} of ${fmt(D[cur].length)} URLs`;
  document.getElementById('pg').textContent=`Page ${page+1} of ${pages}`;
  document.getElementById('prev').disabled=page===0;document.getElementById('next').disabled=page>=pages-1;
  const has=k=>COLS[cur].some(c=>c[0]===k);fl.hidden=!has('l');fy.hidden=!has('y');ft.hidden=!has('t');}
document.querySelectorAll('.inv-tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.inv-tabs button').forEach(x=>x.classList.toggle('on',x===b));cur=b.dataset.k;page=0;fl.value=fy.value=ft.value='';render()});
[q,fl,fy,ft].forEach(e=>e.addEventListener('input',()=>{page=0;render()}));
document.getElementById('prev').onclick=()=>{page--;render()};document.getElementById('next').onclick=()=>{page++;render()};
document.getElementById('csv').onclick=()=>{const cols=COLS[cur];const R=rows();const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const txt='﻿'+cols.map(c=>esc(c[1])).join(',')+'\n'+R.map(r=>cols.map(([k])=>esc((k==='u'||k==='f')&&r[k]&&!String(r[k]).startsWith('http')?H0+r[k]:r[k])).join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/csv'}));a.download=`asahi-kasei-news-${cur}.csv`;a.click()};
document.getElementById('urls').onclick=()=>{const R=rows();const txt=R.map(r=>(String(r.u).startsWith('http')?'':H0)+r.u).join('\n')+'\n';
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain'}));a.download=`asahi-kasei-news-${cur}-urls.txt`;a.click()};
render();
'''

year_rows = ''.join(
    f'<tr><td>FY{r["y"]}</td><td class="n">{r["idx"]}</td><td class="n">{r["jpn"]}</td><td class="n">{r["jpc"]}</td><td class="n">{r["enidx"]}</td><td class="n">{r["enn"]}</td><td class="n"><b>{r["idx"]+r["jpn"]+r["jpc"]+r["enidx"]+r["enn"]}</b></td><td class="n">{r["pdf"]}</td><td class="n">{r["enpdf"]}</td></tr>'
    for r in by_year)
ysum = lambda k: sum(r[k] for r in by_year)
year_foot = f'<tr><td>Total</td><td class="n">{ysum("idx")}</td><td class="n">{ysum("jpn")}</td><td class="n">{ysum("jpc")}</td><td class="n">{ysum("enidx")}</td><td class="n">{ysum("enn")}</td><td class="n">{n_pages:,}</td><td class="n">{ysum("pdf")}</td><td class="n">{ysum("enpdf")}</td></tr>'

seg_total = n_pages
segbar = ''.join(f'<div style="flex:{tpl[n]};background:{c}" title="{n}: {tpl[n]:,} pages ({tpl[n]/seg_total:.0%})">{tpl[n]/seg_total:.0%}</div>'
                 for n, c in (('Listing', 'var(--s3)'), ('Modern article', 'var(--s1)'), ('Legacy article', 'var(--s2)')))
seg_legend = ''.join(f'<span><i style="background:{c}"></i>{n} — {tpl[n]:,}</span>' for n, c in (('Listing', 'var(--s3)'), ('Modern article', 'var(--s1)'), ('Legacy article', 'var(--s2)')))

def eff_bars():
    vals = [((2, 4), (2, 2)), ((20, 20), (24, 28)), ((6, 10), (8, 12)), ((5, 5), (5, 5))]
    mx = 30
    out = []
    for (name, b, p, _), (bv, pv) in zip(EFFORT, vals):
        out.append(f'<div class="brow"><span>{name}</span><div class="btrack" title="Deck {b} · Asahi Kasei {p}">'
                   f'<div class="bbase" style="width:{bv[1]/mx*100:.1f}%"></div><div class="bplan" style="width:{pv[1]/mx*100:.1f}%"></div></div>'
                   f'<span class="muted">{b} → <b style="color:var(--text)">{p}</b></span></div>')
    return ''.join(out)

NAV = [('Summary', [('overview', 'Overview')]),
       ('Scope', [('method', 'How the scope was built'), ('volume', 'Volume by fiscal year'), ('templates', 'Templates & scripts'), ('mapping', 'Block mapping')]),
       ('Plan', [('prereq', 'Prerequisites'), ('risks', 'Risks & importer notes'), ('next', 'Next steps')]),
       ('Data', [('inventory', 'URL inventory'), ('files', 'Deliverables')])]
nav_html = ''.join(f'<div class="grp">{g}</div>' + ''.join(f'<a href="#{i}">{n}</a>' for i, n in items) for g, items in NAV)

fit_html = ''.join(f'<div class="f {"yes" if y else "no"}"><div class="m">{"✓" if y else "–"}</div><div><b>{a}</b><small>{b}</small></div></div>' for y, a, b in FIT)
risk_html = ''.join(f'<div class="risk {lv}"><div class="lvl">{"▲" if lv=="high" else "●" if lv=="medium" else "○"} {lv}</div><div><h5>{t}</h5><p>{d}</p></div><div class="mit"><b>Mitigation</b>{m}</div></div>' for lv, t, d, m in RISKS)
flow_html = ''.join(f'<div class="st"><b>{a}</b><span>{b}</span><small>{c}</small></div>' for a, b, c in STEPS)
files_html = ''.join(f'<div class="card"><code>{a}</code><p>{b}</p></div>' for a, b in DELIVER)
notes_html = ''.join(f'<li>{esc(n)}</li>' for n in S['importerNotes'])

data_json = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
year_tbl = ('<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fiscal year</th><th class="n">JP listings</th><th class="n">JP press &amp; IR</th>'
            '<th class="n">JP CSR</th><th class="n">EN listings</th><th class="n">EN articles</th><th class="n">Pages</th><th class="n">JP PDFs</th>'
            f'<th class="n">EN PDFs</th></tr></thead><tbody>{year_rows}</tbody><tfoot>{year_foot}</tfoot></table></div>')
legend3 = ''.join(f'<span><i style="background:{c}"></i>{n}</span>' for n, c in (('JP press &amp; IR articles', 'var(--s1)'), ('JP CSR articles', 'var(--s2)'), ('EN articles', 'var(--s3)')))
doc = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Asahi Kasei news archive FY2006–2014 · EDS migration scope</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700;800&family=Noto+Sans+JP:wght@400;700&family=Source+Code+Pro:wght@400&display=swap">
<style>{CSS}</style></head><body>
<header class="topbar"><img src="data:image/png;base64,{logo64}" alt="Adobe"><div class="sep"></div><span class="prod">Edge Delivery Services</span><span class="proj">Migration scope · Asahi Kasei news archive</span>
<span class="date">Prepared {today}</span><button class="menu" aria-label="Open sections">☰ Sections</button></header>
<div class="layout"><nav class="side" aria-label="Report sections">{nav_html}</nav><main>

<div class="hero" id="overview"><div class="eyebrow">Migration scope · EDS Importer</div>
<h1>Asahi Kasei news archive, FY2006–FY2014 (Japanese &amp; English)</h1>
<p>We crawled both news sections and checked {fetched:,} URLs one by one. {n_pages:,} pages and {n_docs} PDF attachments belong in the migration scope. The content follows three page patterns, so three import scripts are needed.</p>
<div class="chips"><span class="chip">JP: <a href="{H}/asahi/jp/news/2014/" target="_blank" rel="noopener">/asahi/jp/news/{{2006…2014}}/</a></span><span class="chip">EN: <a href="{H}/asahi/en/news/2014/" target="_blank" rel="noopener">/asahi/en/news/{{2006…2014}}/</a></span><span class="chip">Fiscal year = April – March</span><span class="chip">Recommended tool: EDS Importer</span></div></div>
<div class="tiles">{tiles()}</div>
<div class="grid2" style="margin-top:16px">
 <div class="card"><h3>What is in scope</h3>
 {tbl(['', 'JP', 'EN', 'Total'], [
   ['Year listing pages (All · Press · IR · CSR)', T['jp']['index'], T['en']['index'], T['jp']['index'] + T['en']['index']],
   ['Press &amp; IR articles', T['jp']['newsArticles'], T['en']['newsArticles'], T['jp']['newsArticles'] + T['en']['newsArticles']],
   ['CSR articles', T['jp']['csrArticles'], '—', T['jp']['csrArticles']],
   ['<b>Pages to import</b>', f'<b>{jp_pages:,}</b>', f'<b>{en_pages:,}</b>', f'<b>{n_pages:,}</b>'],
   ['PDF attachments', T['jp']['pdf'], T['en']['pdf'], n_docs]], 'compact')}</div>
 <div class="card"><h3>Pages per import script</h3><p class="muted" style="margin:4px 0 0">Share of the {n_pages:,} pages handled by each script</p>
  <div class="segbar" role="img" aria-label="Listing {tpl['Listing']}, modern article {tpl['Modern article']}, legacy article {tpl['Legacy article']}">{segbar}</div><div class="legend">{seg_legend}</div>
  <h4>Outside the scope</h4>
  <p style="margin:0;font-size:14px"><b>{n_opt}</b> optional sports result pages linked from the FY2007 JP listing, and <b>{n_exc}</b> excluded links that are broken or already redirect to asahi-kasei.com.</p></div>
</div>
<div class="callout good"><div class="ic">✓</div><div><b>Recommendation: use the EDS Importer, not page-by-page migration.</b><br>{esc(S['recommendation'].split(': ',1)[-1])}</div></div>


<section id="method"><h2><span class="num">01</span>How the scope was built</h2>
<p class="lead">The host has no sitemap.xml or robots.txt, and the CSR article folders return 403. The scope was therefore built by crawling the listing pages and following every link until no new URL turned up. Each URL was fetched, and its status, content type and title recorded.</p>
<div class="flow">{flow_html}</div>
<div class="grid3" style="margin-top:16px">
 <div class="card"><h4 style="margin-top:0">In scope</h4><p style="margin:0;font-size:14px">Live (200) pages under <code>/asahi/{{jp,en}}/news/2006–2014/</code> and <code>/asahi/jp/csr/news/2006–2014/</code>, plus PDFs in those folders.</p></div>
 <div class="card"><h4 style="margin-top:0">Optional</h4><p style="margin:0;font-size:14px">{n_opt} live sports result pages (athletics and judo) linked from the news section but stored under <code>/asahi/jp/sports/</code>.</p></div>
 <div class="card"><h4 style="margin-top:0">Excluded</h4><p style="margin:0;font-size:14px">Broken links (404), redirects to asahi-kasei.com, duplicate <code>/index.html</code> aliases, and the missing EN CSR tabs.</p></div>
</div>
<h4>Why URLs were excluded</h4>{tbl(['Reason', 'URLs'], exc_rows, 'compact')}
</section>

<section id="volume"><h2><span class="num">02</span>Volume by fiscal year</h2>
<p class="lead">Articles to import per fiscal year. Hover a column for the breakdown and PDF counts, or switch to the table.</p>
<div class="card"><div class="chart-head"><div class="legend chart-legend">{legend3}</div>
<div class="seg-toggle" role="tablist"><button class="on" data-v="chart">Chart</button><button data-v="table">Table</button></div></div>
<div id="chart"></div>
<div id="yeartable" hidden>{year_tbl}</div></div>
<div class="grid2" style="margin-top:16px"><div class="card"><h3>Articles by category</h3><p class="muted" style="margin:4px 0 8px">Taken from the listing tab that links to each article. This becomes the <code>category</code> metadata.</p>
{tbl(['Category', 'Articles'], [(esc(k), f'{v:,}') for k, v in cat_rows], 'compact')}</div>
<div class="card"><h3>Reading the numbers</h3><ul style="margin:8px 0 0;padding-left:18px;font-size:14px">
<li>Fiscal years run April to March, so the 2014 folder also holds articles dated January–March 2015.</li>
<li>English has no CSR tab. EN listings are All, Press and IR only.</li>
<li>Most PDFs come from FY2010 and FY2011 (product images and data sheets attached to press releases).</li>
<li>“Notice” = articles that appear only on the “All” listing, not under a Press / IR / CSR tab.</li></ul></div></div>
</section>

<section id="templates"><h2><span class="num">03</span>Templates &amp; import scripts</h2>
<p class="lead">Every page shares the same header, side column and footer, but the article content inside comes in two very different forms. As the deck recommends, each pattern gets its own script, and a few pages per pattern are tested in the Workbench first.</p>
{template_cards()}</section>

<section id="mapping"><h2><span class="num">04</span>Proposed block mapping</h2>
<p class="lead">A first draft of how source elements map to EDS blocks and default content. The block list and table structures must be confirmed before parser work starts (deck prerequisite).</p>
{tbl(['Applies to', 'Source element', 'EDS target', 'Type'], [(f'<span class="pill">{a}</span>', f'<code>{b}</code>', c, d if d.startswith('<span') else f'<span class="pill">{d}</span>') for a, b, c, d in MAPPING])}
</section>

<section id="prereq"><h2><span class="num">05</span>Prerequisites before development</h2>
<p class="lead">The deck's checklist for starting importer development, and where this project stands.</p>
{tbl(['Prerequisite', 'Status', 'Detail'], [(a, b, c) for a, b, c in PREREQ])}
</section>


<section id="risks"><h2><span class="num">06</span>Risks &amp; importer notes</h2>
<p class="lead">Edge cases found during the crawl that the import scripts have to handle.</p>
{risk_html}</section>

<section id="next"><h2><span class="num">07</span>Next steps</h2>
<ol class="steps">{numbered(NEXT)}</ol></section>

<section id="inventory"><h2><span class="num">08</span>URL inventory</h2>
<p class="lead">Every URL found in the crawl. Search and filter the lists, then download what you see as CSV, or as a plain URL list for the Bulk importer.</p>
<div class="card">
<div class="inv-tabs" role="tablist"><button class="on" data-k="pages">Pages in scope<em>{n_pages:,}</em></button><button data-k="docs">PDF attachments<em>{n_docs}</em></button><button data-k="opt">Optional<em>{n_opt}</em></button><button data-k="exc">Excluded<em>{n_exc}</em></button></div>
<div class="filters"><input id="q" type="search" placeholder="Search URL, title or reason…" aria-label="Search">
<select id="fl" aria-label="Language"><option value="">All languages</option><option>JP</option><option>EN</option></select>
<select id="fy" aria-label="Fiscal year"><option value="">All fiscal years</option>{''.join(f'<option>{y}</option>' for y in range(2006, 2015))}</select>
<select id="ft" aria-label="Template"><option value="">All templates</option><option>Listing</option><option>Modern article</option><option>Legacy article</option></select>
<button class="btn" id="urls">Download URL list</button><button class="btn primary" id="csv">Download CSV</button><span class="count" id="cnt"></span></div>
<div class="tbl-wrap" style="max-height:640px"><table class="tbl" id="inv"><thead></thead><tbody></tbody></table></div>
<div class="pager"><span id="pg"></span><button class="btn" id="prev">‹ Previous</button><button class="btn" id="next">Next ›</button></div></div>
</section>

<section id="files"><h2><span class="num">09</span>Deliverables</h2>
<p class="lead">Saved with this report in the project's migration folder (<code>asahi-kasei-co-jp-news-scope</code>).</p>
<div class="files">{files_html}</div>
<h4>Importer notes recorded in the scope summary</h4><ul style="font-size:14px;padding-left:18px;margin:0">{notes_html}</ul>
</section>

<footer class="foot"><img src="data:image/png;base64,{logo64}" alt="Adobe"><span>Edge Delivery Services migration · Asahi Kasei news archive FY2006–2014 · crawl of {fetched:,} URLs on {today}</span></footer>
</main></div>
<script type="application/json" id="data">{data_json}</script>
<script>{JS}</script></body></html>'''
open(OUT, 'w').write(doc)
print(OUT, len(doc) // 1024, 'KB')
