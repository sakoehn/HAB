"""Quantify what kegg_paths' BRITE-table occurrences do to (a) the C-level
'pathway' universe and (b) the correlation finder's sibling exclusion
(_kegg_family_exclusions logic replicated in memory over iter_kegg_path_rows)."""
import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, collections, re
from scripts.migrate_kegg_paths_to_sql import iter_kegg_path_rows

ko00001 = sys.argv[1]
ids = set()
with open(ko00001) as f:
    for line in f:
        if line[0] in 'ABCD':
            parts = line[1:].strip().split(None, 1)
            if len(parts) == 2:
                ids.add(parts[0])
rows = list(iter_kegg_path_rows(ko00001, ids))

c_nodes = {}
for r in rows:
    if r['c_id'] and r['d_id'] is None:
        c_nodes[r['c_id']] = (r['a_name'], r['c_name'])
kind = collections.Counter()
for cid, (a, name) in c_nodes.items():
    kind['[PATH:' if '[PATH:' in name else '[BR:' if '[BR:' in name else 'neither (' + a + ')'] += 1
print("depth-3 (C-level) nodes stored as 'pathway':", len(c_nodes), dict(kind))
print("  examples of non-PATH C nodes:", [(cid, n[:40]) for cid, (a, n) in c_nodes.items() if '[PATH:' not in n][:6])
kos_under = collections.Counter(r['c_id'] for r in rows if r['d_id'])
print("  largest C-level groups by KO count:", [(c, n, c_nodes[c][1][:35]) for c, n in kos_under.most_common(6)])

def exclusions(ref):
    excluded = {ref}
    mine = [r for r in rows if r['d_id'] == ref]
    for r in mine:
        excluded.update(v for v in (r['a_id'], r['b_id'], r['c_id'], r['d_id']) if v)
    real_parents = {r['c_id'] for r in mine if r['c_id']}
    sib = {r['d_id'] for r in rows if r['c_id'] in real_parents and r['d_id']}
    excluded |= sib
    return excluded, real_parents

all_kos = {r['d_id'] for r in rows if r['d_id']}
print("KOs in ko00001:", len(all_kos))
for ref in ['K00844', 'K02703', 'K01601', 'K01428', 'K03924', 'K00001', 'K02014']:
    ex, parents = exclusions(ref)
    path_parents = [p for p in parents if '[PATH:' in c_nodes.get(p, ('', ''))[1]]
    brite_parents = [p for p in parents if '[PATH:' not in c_nodes.get(p, ('', ''))[1]]
    ex_without_brite = {ref}
    mine = [r for r in rows if r['d_id'] == ref and r['c_id'] in path_parents]
    for r in mine:
        ex_without_brite.update(v for v in (r['a_id'], r['b_id'], r['c_id'], r['d_id']) if v)
    ex_without_brite |= {r['d_id'] for r in rows if r['c_id'] in path_parents and r['d_id']}
    print(f"{ref}: real immediate parents={len(parents)} (PATH {len(path_parents)}, BRITE/other {len(brite_parents)} "
          f"{[c_nodes[p][1][:28] for p in brite_parents][:4]}) -> KOs excluded as siblings/relatives: "
          f"{len(ex & all_kos)} of {len(all_kos)}; with only PATH parents it would be {len(ex_without_brite & all_kos)}")
