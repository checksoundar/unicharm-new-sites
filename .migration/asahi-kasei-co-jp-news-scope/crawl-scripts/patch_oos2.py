"""Patch report.py: add the Out of scope section, nav entry, hero text; renumber sections."""
import re
p = '/tmp/ak/scripts/report.py'
s = open(p).read()


def rep(a, b):
    global s
    if a not in s:
        raise SystemExit('MISSING: ' + a[:90])
    s = s.replace(a, b)


# source column key must not render as a link
rep("f=o['source']) for o in OOS]", "o=o['source']) for o in OOS]")
rep("['n','Page title'],['f','Source']],", "['n','Page title'],['o','Source']],")

# nav
rep("('Scope', [('method', 'How the scope was built'), ", "('Scope', [('method', 'How the scope was built'), ('outofscope', 'Out of scope'), ")

# hero
rep("{n_pages:,} pages and {n_docs} PDF attachments belong in the migration scope.",
    "{n_pages:,} pages and {n_docs} PDF attachments belong in the migration scope. CSR content ({n_oos} URLs) is out of scope.")

# section builder (python side, inserted before data_json)
builder = r'''
BEFORE = dict(pages=1178, jp=896, en=282, listing=63, legacy=554, modern=561, optional=41, excluded=173, pdf=155)
AFTER = dict(pages=n_pages, jp=jp_pages, en=en_pages, listing=tpl['Listing'], legacy=tpl['Legacy article'], modern=tpl['Modern article'], optional=n_opt, excluded=n_exc, pdf=n_docs)
oos_kind = collections.Counter(o['kind'] for o in OOS)
OOS_TILES = [('CSR articles', oos_kind['CSR article'], '/asahi/jp/csr/news/{yyyy}/…'),
             ('CSR listing tabs', oos_kind['CSR listing tab'], '/asahi/jp/news/{yyyy}/csr.html'),
             ('Press / IR releases on the CSR tab', oos_kind['Press/IR release also on CSR tab'], 'also listed under Press or IR'),
             ('Other linked pages', oos_kind['CSR section page (redirects)'] + oos_kind['Sports page linked from CSR tab'], '2 CSR redirects · 1 sports page')]
oos_tiles = ''.join(f'<div class="tile tile-oos"><div class="tile-label">{a}</div><div class="tile-value">{b}</div><div class="tile-sub">{esc(c)}</div></div>' for a, b, c in OOS_TILES)
ba_rows = []
for label, k in (('Pages to import', 'pages'), ('— Japanese', 'jp'), ('— English', 'en'), ('Listing pages', 'listing'), ('Modern articles (FY2011–2014)', 'modern'),
                 ('Legacy articles (FY2006–2010)', 'legacy'), ('PDF attachments', 'pdf'), ('Optional pages', 'optional'), ('Excluded links', 'excluded')):
    d = AFTER[k] - BEFORE[k]
    ba_rows.append((label, f'{BEFORE[k]:,}', f'<b>{AFTER[k]:,}</b>', f'<span class="delta{" neg" if d < 0 else ""}">{d:+,}</span>' if d else '<span class="muted">no change</span>'))
fy_oos = collections.defaultdict(collections.Counter)
for o in OOS:
    fy_oos[o['fy']]['tab' if o['kind'] == 'CSR listing tab' else 'art' if o['kind'] == 'CSR article' else 'other'] += 1
fy_rows = [(f'FY{y}', fy_oos[y]['tab'], fy_oos[y]['art'], fy_oos[y]['other'], f'<b>{sum(fy_oos[y].values())}</b>') for y in range(2006, 2015)]
fy_rows.append(('<b>Total</b>', f"<b>{sum(c['tab'] for c in fy_oos.values())}</b>", f"<b>{sum(c['art'] for c in fy_oos.values())}</b>", f"<b>{sum(c['other'] for c in fy_oos.values())}</b>", f'<b>{n_oos}</b>'))
cross = [o for o in OOS if o['kind'] == 'Press/IR release also on CSR tab']
orphan = [o for o in OOS if o['sheetRows'] == 0]
dups = [o for o in OOS if o['sheetRows'] > 1]
redir = [o for o in OOS if o['status'] in (301, 302)]
sheet_rows = sum(o['sheetRows'] for o in OOS)
CONFIRM = [
    ('Press releases on the CSR tab', f'{len(cross)} releases appear on both the CSR tab and the Press or IR tab. They are out of scope because they are on the CSR sheet. If they should be migrated, they move back to Press/IR: '
     + ', '.join(link(o['url'][len(H):], o['url'].rsplit('/', 1)[1]) for o in cross) + '.'),
    ('One CSR article not on the sheet', ', '.join(link(o['url'][len(H):]) for o in orphan) + ' is a CSR article by its address but is linked only from the FY2007 “All” listing, not from a CSR tab. It is treated as out of scope too.'),
    ('Sheet rows vs. unique URLs', f'The sheet has {sheet_rows} rows. ' + ', '.join(f'<code>{esc(o["url"][len(H):])}</code>' for o in dups)
     + f' appears twice (FY2012 and FY2013 tabs), so the sheet holds {sheet_rows - len(dups)} unique URLs. With the article above, {n_oos} unique URLs are out of scope.'),
    ('Already redirected', ', '.join(f'<code>{esc(o["url"][len(H):])}</code>' for o in redir) + ' already redirect to asahi-kasei.com; nothing to migrate.'),
    ('PDFs are unaffected', f'No PDF is linked only from CSR pages, so all {n_docs} PDF attachments stay in scope.'),
]
confirm_html = ''.join(f'<li><b>{a}</b><span>{b}</span></li>' for a, b in CONFIRM)
oos_list = ''.join(f'<tr><td class="u">{link(o["url"][len(H):])}</td><td class="n">{o["fy"]}</td><td><span class="pill">{esc(o["kind"])}</span></td><td class="t">{esc(o["title"]) if o["status"] == 200 else "Redirects to " + esc(o.get("location") or "")}</td></tr>' for o in OOS)
OOS_SECTION = f"""<section id="outofscope"><h2><span class="num">00</span>Out of scope</h2>
<p class="lead">As agreed with the client (CSR URL sheet, {sheet_rows} rows), <b>CSR content will not be migrated</b>. These URLs are removed from the import lists and from every count in this report.</p>
<div class="tiles">{oos_tiles}</div>
<div class="grid2" style="margin-top:16px">
 <div class="card"><h3>Impact on the scope</h3><p class="muted" style="margin:4px 0 8px">Before and after removing CSR</p>{tbl(['', 'Before', 'After', 'Change'], ba_rows, 'compact')}</div>
 <div class="card"><h3>Out-of-scope URLs by fiscal year</h3><p class="muted" style="margin:4px 0 8px">“Other” = press releases on the CSR tab, CSR redirects and the sports page</p>{tbl(['Fiscal year', 'CSR tab', 'CSR articles', 'Other', 'Total'], fy_rows, 'compact')}</div>
</div>
<div class="card" style="margin-top:16px"><h3>Points to confirm with the client</h3><ul class="confirm">{confirm_html}</ul></div>
<div class="card" style="margin-top:16px"><div class="chart-head"><h3>All {n_oos} out-of-scope URLs</h3><button class="btn" id="oos-open">Open in URL inventory</button></div>
<div class="tbl-wrap" style="max-height:440px"><table class="tbl"><thead><tr><th>URL</th><th class="n">FY</th><th>Type</th><th>Page title</th></tr></thead><tbody>{oos_list}</tbody></table></div></div>
</section>
"""
'''
rep("data_json = json.dumps(", builder + "data_json = json.dumps(")

# place the section after "How the scope was built"
a = s.index('<section id="volume">')
s = s[:a] + '{OOS_SECTION}\n' + s[a:]

# renumber visible section numbers in order
n = iter(range(1, 30))
s = re.sub(r'<span class="num">\d\d</span>(?=How|Out of scope|Volume|Templates|Proposed|Prerequisites|Risks|Next|URL inventory|Deliverables)',
           lambda m: f'<span class="num">{next(n):02d}</span>', s)

# css
rep(".muted{color:var(--muted);font-size:13px}",
    ".muted{color:var(--muted);font-size:13px}\n.tile-oos{border-top-color:#6e6e6e}\n.delta{font-weight:700;color:var(--text-2)}.delta.neg{color:var(--crit)}\n"
    "ul.confirm{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:10px}ul.confirm li{display:grid;grid-template-columns:240px minmax(0,1fr);gap:14px;padding:10px 12px;border:1px solid var(--border);border-left:3px solid var(--warn);border-radius:6px;background:#fffdf9;font-size:14px}\n"
    "@media (max-width:860px){ul.confirm li{grid-template-columns:1fr}}")

# js: open inventory tab
rep("render();\n'''", "render();\ndocument.getElementById('oos-open').onclick=()=>{document.querySelector('.inv-tabs button[data-k=\"oos\"]').click();document.getElementById('inventory').scrollIntoView()};\n'''")
open(p, 'w').write(s)
print('patched', s.count('<span class="num">'))
