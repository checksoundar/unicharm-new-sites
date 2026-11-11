"""Patch report.py: CSR out of scope (chart, overview, method, inventory, risks)."""
p = '/tmp/ak/scripts/report.py'
s = open(p).read()


def rep(a, b):
    global s
    if a not in s:
        raise SystemExit('MISSING: ' + a[:90])
    s = s.replace(a, b)


# --- data
rep("X = json.load(open(os.path.join(SCOPE, 'excluded.json')))",
    "X = json.load(open(os.path.join(SCOPE, 'excluded.json')))\nOOS = json.load(open(os.path.join(SCOPE, 'out-of-scope-csr.json')))['urls']")
rep("exc = [dict(",
    "oos = [dict(u=o['url'][len(H):], y=o['fy'], t=o['kind'], s=o['status'], n=o['title'] if o['status'] == 200 else 'Redirects to ' + (o.get('location') or ''), f=o['source']) for o in OOS]\nexc = [dict(")
rep("data = dict(pages=pages, docs=docs, opt=opt, exc=exc, years=by_year)",
    "data = dict(pages=pages, docs=docs, opt=opt, exc=exc, oos=oos, years=by_year)\nn_oos = len(OOS)")
rep("        ('Excluded links', f'{n_exc}', 'broken or already redirected'),\n", "")
rep("        ('Import scripts', '3', 'listing · modern · legacy'),",
    "        ('Out of scope (CSR)', f'{len(OOS)}', 'per the client’s CSR URL sheet'),\n        ('Import scripts', '3', 'listing · modern · legacy'),")
# --- templates / risks / prereq
rep("desc='The year listing and its Press / IR / CSR tabs. The markup is the same in every year.'",
    "desc='The year listing (“All”) and its Press and IR tabs. The markup is the same in every year. The JP CSR tab is out of scope.'")
a = s.index("    ('low', 'CSR folders are locked'")
b = s.index("\n", a) + 1
s = s[:a] + ("    ('medium', 'Links to out-of-scope CSR pages', 'JP “All” listings, and a few press releases, link to CSR articles that will not be migrated.', "
             "'The listing script drops CSR rows (or points them to asahi-kasei.com). The import report flags any remaining links to <code>/csr/</code>.'),\n") + s[b:]
rep("{n_opt} optional, {n_exc} excluded. No sitemap", "{n_opt} optional, {n_exc} excluded, {len(OOS)} CSR URLs out of scope. No sitemap")
# --- year table / chart
rep('<td class="n">{r["jpc"]}</td>', '')
rep('+r["jpc"]', '')
rep('<td class="n">{ysum("jpc")}</td>', '')
rep('<th class="n">JP CSR</th><th class="n">EN listings</th>', '<th class="n">EN listings</th>')
rep("(('JP press &amp; IR articles', 'var(--s1)'), ('JP CSR articles', 'var(--s2)'), ('EN articles', 'var(--s3)'))",
    "(('JP press &amp; IR articles', 'var(--s1)'), ('EN articles', 'var(--s3)'))")
rep("{k:'jpc',n:'JP CSR articles',c:'var(--s2)'},", "")
rep("stacked by JP press and IR, JP CSR and EN", "stacked by JP press and IR and EN")
# --- overview
rep("['Year listing pages (All · Press · IR · CSR)',", "['Year listing pages (All · Press · IR)',")
rep("   ['CSR articles', T['jp']['csrArticles'], '—', T['jp']['csrArticles']],\n", "")
a = s.index("  <h4>Outside the scope</h4>")
b = s.index("</p></div>", a) + len("</p></div>")
s = s[:a] + ('  <h4>Outside the scope</h4>\n  <p style="margin:0;font-size:14px"><b>{n_oos}</b> CSR URLs are out of scope (see <a href="#outofscope">Out of scope</a>). '
             'There are also <b>{n_opt}</b> optional sports result pages and <b>{n_exc}</b> excluded links that are broken or already redirect to asahi-kasei.com.</p></div>') + s[b:]
# --- method cards
rep('<div class="grid3" style="margin-top:16px">', '<div class="grid4" style="margin-top:16px">')
a = s.index(" and <code>/asahi/jp/csr/news/2006")
b = s.index("plus PDFs in", a)
s = s[:a] + " (Press, IR and notices), " + s[b:]
rep("and the missing EN CSR tabs.</p></div>",
    "and the missing EN CSR tabs.</p></div>\n <div class=\"card\"><h4 style=\"margin-top:0\">Out of scope</h4><p style=\"margin:0;font-size:14px\">{n_oos} CSR URLs from the client’s CSR sheet: CSR tabs, CSR articles and the pages they link to. <a href=\"#outofscope\">Details</a></p></div>")
rep(".grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}",
    ".grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}")
rep(".files,.grid3{grid-template-columns:1fr 1fr}", ".files,.grid3,.grid4{grid-template-columns:1fr 1fr}")
rep(".files,.grid3{grid-template-columns:1fr}", ".files,.grid3,.grid4{grid-template-columns:1fr}")
# --- reading the numbers
rep("<li>English has no CSR tab. EN listings are All, Press and IR only.</li>", "<li>CSR is out of scope, so JP CSR articles are not counted. English has no CSR tab.</li>")
rep("not under a Press / IR / CSR tab.", "not under the Press or IR tab.")
# --- inventory
rep("opt:[['u','URL'],['n','Page title'],['f','Linked from']],",
    "opt:[['u','URL'],['n','Page title'],['f','Linked from']],oos:[['u','URL'],['y','FY'],['t','Type'],['n','Page title'],['f','Source']],")
rep('<button data-k="exc">Excluded', '<button data-k="oos">Out of scope (CSR)<em>{n_oos}</em></button><button data-k="exc">Excluded')
open(p, 'w').write(s)
print('patched')
