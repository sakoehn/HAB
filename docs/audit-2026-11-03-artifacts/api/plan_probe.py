import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, sqlite3
from create_sql_schema import SCHEMA; from create_sql_indexes import INDEXES
conn = sqlite3.connect(':memory:'); conn.executescript(SCHEMA); conn.executescript(INDEXES)
# a small, realistically shaped table: 4 sources x 128 samples x N ids
import random
random.seed(1)
rows=[]
for src, n in (('taxonomy',400),('kegg',200),('cog',100),('enzyme',100)):
    for s in range(128):
        for i in range(n):
            rows.append((src, f'S{s:03d}', f'{src}_{i}', 'n', 'p', 1, random.random(), random.random()))
conn.executemany("INSERT INTO annotation_series(source,sample,annotation_id,name,parent,depth,egc,norm_egc) VALUES (?,?,?,?,?,?,?,?)", rows)
conn.commit()
samples=[f'S{s:03d}' for s in range(18)]
ph=",".join("?"*len(samples))
q=f"""SELECT annotation_id, MIN(name), MIN(parent), MIN(depth), AVG(egc), MAX(egc), AVG(norm_egc), MAX(norm_egc), COUNT(DISTINCT sample)
      FROM annotation_series WHERE source = ? AND sample IN ({ph}) GROUP BY annotation_id ORDER BY 5 DESC"""
def plan(sql, params):
    for r in conn.execute("EXPLAIN QUERY PLAN "+sql, params): print('   ', r[3])
print('current query, no ANALYZE:'); plan(q, ['taxonomy',*samples])
conn.execute('ANALYZE'); print('current query, after ANALYZE:'); plan(q, ['taxonomy',*samples])
conn.execute("CREATE INDEX idx_tmp ON annotation_series(sample, source, annotation_id, egc, norm_egc, name, parent, depth)")
conn.execute('ANALYZE'); print('with covering (sample, source, ...) index:'); plan(q, ['taxonomy',*samples])
