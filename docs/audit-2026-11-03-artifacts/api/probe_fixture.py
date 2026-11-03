import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, sqlite3
from create_sql_schema import SCHEMA
from create_sql_indexes import INDEXES
from api import cache_sql
from api import routes
from api.cache import AnnotationSource

conn = sqlite3.connect(':memory:')
conn.executescript(SCHEMA); conn.executescript(INDEXES)

# --- Probe 1: bypass_cap still truncated by the unconditional LIMIT ---
conn.execute("INSERT INTO kegg_paths(a_id,a_name,b_id,b_name,c_id,c_name,d_id,d_name,full_path) VALUES ('09100','Metabolism','09101','Carb','00010','Glyc','K00001','adh','p1')")
for i, s in enumerate(['S1']*3 + ['S2']*3):
    conn.execute("INSERT INTO mappings(sample,gene_id,scaffold_id,taxon_path_id,kegg_id) VALUES (?,?,?,?,?)", (s, f'g{i}', f'sc{i}', None, 'KO:K00001'))
conn.commit()
cache_sql._MAPPINGS_ROW_LIMIT = 4
rows = cache_sql.get_mappings_sql(conn, 'kegg', 'K00001', samples=['S1','S2'], bypass_cap=True)
print('PROBE1 bypass_cap=True: real rows = 6, returned =', len(rows), '-> truncated' if len(rows) < 6 else '-> complete')
print('       samples represented:', sorted({r["sample"] for r in rows}))

# --- Probe 2: include_parent for a parent that exists in kegg_paths but has no catalog row ---
conn.execute("INSERT INTO annotation_catalog(source,annotation_id,name,parent,mean_egc,max_egc,mean_norm_egc,max_norm_egc,sample_count,depth) VALUES ('kegg','K00001','adh','00010',1,1,0.1,0.1,1,4)")
conn.execute("INSERT INTO annotation_series(source,sample,annotation_id,name,egc,norm_egc) VALUES ('kegg','S1','K00001','adh',1,0.1)")
conn.commit()
try:
    plan = routes._series_export_plan(conn, AnnotationSource.kegg, '00010', 'ko', None, None, include_parent=True)
    print('PROBE2 include_parent on data-less parent: OK, start =', plan['start'])
except BaseException as e:
    print('PROBE2 include_parent on data-less parent raised:', type(e).__name__, repr(e)[:80])

# --- Probe 3: query plan for the sample list ---
for q in ["SELECT DISTINCT sample FROM mappings ORDER BY sample",
          "WITH RECURSIVE s(x) AS (SELECT MIN(sample) FROM mappings UNION ALL SELECT (SELECT MIN(sample) FROM mappings WHERE sample > x) FROM s WHERE x IS NOT NULL) SELECT x FROM s WHERE x IS NOT NULL"]:
    print('PROBE3 plan for:', q[:60])
    for r in conn.execute("EXPLAIN QUERY PLAN " + q): print('      ', r[3])

# --- Probe 4: top-annotations cache key conflates bare date with midnight datetime ---
from api.index import is_within_date_range, _parse_any_datetime
k1 = _parse_any_datetime('2021-06-05').isoformat(); k2 = _parse_any_datetime('2021-06-05T00:00:00').isoformat()
print('PROBE4 cache keys equal:', k1 == k2, '| 6/5/21 21:00 within date_to=2021-06-05:', is_within_date_range('6/5/21 21:00', None, '2021-06-05'), '| within date_to=2021-06-05T00:00:00:', is_within_date_range('6/5/21 21:00', None, '2021-06-05T00:00:00'))

# --- Probe 5: results_were_truncated reads true at exactly the budget ---
cache_sql._MAPPINGS_ROW_LIMIT = 6
rows = cache_sql.get_mappings_sql(conn, 'kegg', 'K00001', samples=['S1','S2'])
print('PROBE5 exactly-at-limit: rows', len(rows), 'results_were_truncated would be', len(rows) >= cache_sql._MAPPINGS_ROW_LIMIT)
