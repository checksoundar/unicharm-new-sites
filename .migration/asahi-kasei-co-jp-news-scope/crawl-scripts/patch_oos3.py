p = '/tmp/ak/scripts/report.py'
s = open(p).read()
a = "    ('excluded.json', 'Every excluded URL with status and reason'),"
assert a in s
s = s.replace(a, a + "\n    ('out-of-scope-csr.txt · .json', f'The {len(OOS)} CSR URLs that are out of scope, with type, fiscal year and source'),")
s = s.replace("('migration-scope.csv', 'Every URL with locale, fiscal year, type, title and in-scope flag (opens in Excel)')",
              "('migration-scope.csv', 'Every URL with locale, fiscal year, type, title and in-scope flag, including the CSR rows marked out of scope (opens in Excel)')")
open(p, 'w').write(s)
print('ok')
