import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, sqlite3, time, random, os
from create_sql_schema import SCHEMA; from create_sql_indexes import INDEXES
path = './plan_timing.db'
if os.path.exists(path): os.remove(path)
conn = sqlite3.connect(path); conn.executescript(SCHEMA)
random.seed(1)
# insertion order mirrors the migration: per source, per sample, all ids
def gen():
    for src, n in (('kegg',1500),('cog',800),('taxonomy',7000)):
        for s in range(128):
            for i in range(n):
                yield (src, f'S{s:03d}', f'{src}_{i:05d}', 'name', 'parent', 3, random.random()*1000, random.random())
conn.executemany("INSERT INTO annotation_series(source,sample,annotation_id,name,parent,depth,egc,norm_egc) VALUES (?,?,?,?,?,?,?,?)", gen())
conn.commit(); conn.executescript(INDEXES); conn.commit()
n = conn.execute("SELECT COUNT(*) FROM annotation_series").fetchone()[0]
samples=[f'S{s:03d}' for s in range(18)]; ph=",".join("?"*18)
base = f"""SELECT annotation_id, MIN(name), MIN(parent), MIN(depth), AVG(egc), MAX(egc), AVG(norm_egc), MAX(norm_egc), COUNT(DISTINCT sample)
      FROM annotation_series {{hint}} WHERE source = ? AND sample IN ({ph}) GROUP BY annotation_id ORDER BY 5 DESC"""
def run(label, hint):
    q = base.format(hint=hint)
    print(label, '| plan:', [r[3] for r in conn.execute("EXPLAIN QUERY PLAN "+q, ['taxonomy',*samples])][0])
    t=time.perf_counter(); rows=conn.execute(q, ['taxonomy',*samples]).fetchall(); dt=time.perf_counter()-t
    print(f'   {len(rows)} groups in {dt:.2f}s')
print('rows:', n)
run('as written (no stats)', '')
run('forced UNIQUE(source,sample,annotation_id) index', 'INDEXED BY sqlite_autoindex_annotation_series_1')
conn.execute('ANALYZE'); conn.commit()
run('as written after ANALYZE', '')
