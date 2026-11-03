"""Run the notebooks' BRITE parsers and the path-table builders against the
live ko00001.keg / ko01000.keg (passed as argv), and run the KEGG roll-up
(EGC_KEGG_TREE cell 7 logic, copied verbatim) on a synthetic kegg_db."""
import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, re, collections
from api.ec_renumbering import TRANSFERRED_EC, resolve_or_drop_ec
from scripts.migrate_kegg_paths_to_sql import iter_kegg_path_rows
from scripts.migrate_enzyme_paths_to_sql import iter_enzyme_path_rows
from scripts.download_enzyme_brite import validate_brite_text

ko00001, ko01000 = sys.argv[1], sys.argv[2]

# ───────────── KEGG: EGC_KEGG_TREE cell 5, verbatim ─────────────
with open(ko00001) as f:
    keg_lines = f.readlines()
brite = {}; brite_occurances = {}; current_at_depth = {}
depth_of = collections.defaultdict(set); names_of = collections.defaultdict(set)
skipped_short = []; letters = collections.Counter()
for line in keg_lines:
    if not any(line.startswith(c) for c in 'ABCDEFGHIJK'):
        continue
    level_char = line[0]; letters[level_char] += 1
    depth      = ord(level_char) - ord('A') + 1
    rest       = line[1:].strip()
    if not rest:
        continue
    parts = rest.split(None, 1)
    if len(parts) < 2:
        skipped_short.append(line.rstrip()); continue
    node_id, name = parts[0], parts[1]
    parent        = current_at_depth.get(depth - 1)
    category      = name if depth == 1 else current_at_depth.get(1, {}).get('name')
    current_at_depth[depth] = {'id': node_id, 'name': name}
    for d in list(current_at_depth):
        if d > depth:
            del current_at_depth[d]
    brite[node_id] = {'name': name, 'depth': depth, 'category': category,
                      'parent_id': parent['id'] if parent else None,
                      'parent_name': parent['name'] if parent else None}
    brite_occurances.setdefault(node_id, []).append(
        {'parent_id': parent['id'] if parent else None, 'top_level': category})
    depth_of[node_id].add(depth); names_of[node_id].add(name)

print("=== ko00001.keg ===")
print("line-letter counts:", dict(letters))
print("brite nodes:", len(brite), " skipped short A-D lines:", len(skipped_short), skipped_short[:5])
multi_depth = {k: v for k, v in depth_of.items() if len(v) > 1}
print("ids at >1 depth:", len(multi_depth), list(multi_depth.items())[:10])
multi_name = {k: v for k, v in names_of.items() if len(v) > 1}
print("ids with >1 distinct name:", len(multi_name), list(multi_name.items())[:5])
kos = [k for k in brite if brite[k]['depth'] == 4]
multi_parent_kos = [k for k in kos if len({o['parent_id'] for o in brite_occurances[k]}) > 1]
print("KOs:", len(kos), " multi-parent KOs:", len(multi_parent_kos))
cat_dist = collections.Counter(brite[k]['category'] for k in kos)
print("last-occurrence category of KO leaves:", cat_dist.most_common())
PATHWAY_TOPS = {'Metabolism', 'Genetic Information Processing', 'Environmental Information Processing',
                'Cellular Processes', 'Organismal Systems', 'Human Diseases'}
misfiled = [k for k in kos if brite[k]['category'] not in PATHWAY_TOPS
            and any(o['top_level'] in PATHWAY_TOPS for o in brite_occurances[k])]
print("KOs whose stored category/parent is a BRITE/Not-included section although they ARE in a pathway:",
      len(misfiled), "e.g.", [(k, brite[k]['parent_id'], brite[k]['parent_name'][:40]) for k in misfiled[:3]])
print("  K00844:", brite.get('K00844'))
c_nodes = [k for k in brite if brite[k]['depth'] == 3]
multi_parent_c = [k for k in c_nodes if len({o['parent_id'] for o in brite_occurances[k]}) > 1]
print("C-level nodes:", len(c_nodes), " with >1 distinct parent:", len(multi_parent_c), multi_parent_c[:10])
b_nodes = [k for k in brite if brite[k]['depth'] == 2]
multi_parent_b = [k for k in b_nodes if len({o['parent_id'] for o in brite_occurances[k]}) > 1]
print("B-level nodes:", len(b_nodes), " with >1 distinct parent:", len(multi_parent_b), multi_parent_b[:10])

# kegg_paths builder with every id valid
rows = list(iter_kegg_path_rows(ko00001, set(brite)))
fp = collections.Counter(r['full_path'] for r in rows)
dups = [p for p, n in fp.items() if n > 1]
print("kegg_paths rows (all ids valid):", len(rows), " duplicate full_path (UNIQUE would fail):", len(dups), dups[:5])
# every occurrence of a KO captured?
occ_from_paths = collections.Counter(r['d_id'] for r in rows if r['d_id'])
mismatch = [k for k in kos if occ_from_paths[k] != len(brite_occurances[k])]
print("KOs whose kegg_paths row count != notebook occurrence count:", len(mismatch), mismatch[:5])

# ───────────── KEGG roll-up: EGC_KEGG_TREE cell 7, verbatim ─────────────
def rollup(kegg_db):
    tax_tree = {}
    for gene_id, ginfo in kegg_db.items():
        scaffold   = gene_id.rsplit('_', 2)[0]
        for full_path, sample in zip(ginfo['lookupId'], ginfo['timepoint']):
            ko_id = full_path.split(';')[0].strip()
            if ko_id.startswith('KO:'): ko_id = ko_id[3:]
            if ko_id not in brite: continue
            to_visit = [ko_id]; visited = set()
            while to_visit:
                current = to_visit.pop()
                if current in visited: continue
                visited.add(current)
                if current not in brite: continue
                if current not in tax_tree:
                    b = brite[current]
                    tax_tree[current] = {'name': b['name'], 'depth': b['depth'], 'timepoints': {}}
                node = tax_tree[current]
                if sample not in node['timepoints']:
                    node['timepoints'][sample] = {'scaffolds': {}, 'genes': set()}
                tp = node['timepoints'][sample]
                if gene_id not in tp['genes']:
                    tp['scaffolds'][scaffold] = tp['scaffolds'].get(scaffold, 0) + 1
                tp['genes'].add(gene_id)
                for occ in brite_occurances[current]:
                    parent_id = occ['parent_id']
                    if parent_id is None: continue
                    if parent_id not in visited: to_visit.append(parent_id)
    return tax_tree

print("\n=== synthetic roll-up ===")
print("K00844 in 00010:", any(o['parent_id'] == '00010' for o in brite_occurances['K00844']),
      " K12407 in 00010:", any(o['parent_id'] == '00010' for o in brite_occurances.get('K12407', [])))
kegg_db = {
    'Ga1_0001_1_2': {'lookupId': ['KO:K00844', 'KO:K12407'], 'timepoint': ['S1', 'S1']},  # 2 KOs, same pathway
    'Ga1_0001_3_4': {'lookupId': ['KO:K00844'], 'timepoint': ['S1']},
    'Ga1_0002_1_2': {'lookupId': ['KO:K00844', 'KO:K00844'], 'timepoint': ['S1', 'S1']},  # duplicate rows
}
t = rollup(kegg_db)
for node in ['K00844', 'K12407', '00010', '09101', '09100', '01000', '09181', '09180']:
    if node in t:
        print(f"  {node:6s} {t[node]['name'][:45]:45s} S1 scaffolds={t[node]['timepoints']['S1']['scaffolds']} genes={len(t[node]['timepoints']['S1']['genes'])}")
print("  nodes touched:", len(t))

# ───────────── Enzyme: EGC_ENZYME_TREE cell 7, verbatim ─────────────
with open(ko01000, encoding='utf-8') as f:
    brite_file = f.read()
try:
    validate_brite_text(brite_file); print("\n=== ko01000.keg === validate_brite_text: OK")
except ValueError as e:
    print("\n=== ko01000.keg === validate_brite_text FAILED:", e)
ebrite = {}; current_at_depth = {}; edepth_of = collections.defaultdict(set); regex_fail = []; nameless = []
for raw_line in brite_file.splitlines():
    line = raw_line.strip()
    if not line or line[0] not in "ABCDEFGHIJK": continue
    depth = ord(line[0]) - ord('A') + 1
    rest = re.sub(r"<[^>]+>", "", line[1:]).strip()
    if not rest: continue
    m = re.match(r"^(\d+(?:\.\d+){0,3})\.?(?:\s+(.+))?$", rest)
    if not m:
        if depth <= 4: regex_fail.append(line[:80])
        continue
    node_id = m.group(1); name = (m.group(2) or node_id).strip()
    if m.group(2) is None: nameless.append(line)
    parent = current_at_depth.get(depth - 1)
    category = name if depth == 1 else current_at_depth.get(1, {}).get('name')
    current_at_depth[depth] = {'id': node_id, 'name': name}
    for d in list(current_at_depth.keys()):
        if d > depth: del current_at_depth[d]
    ebrite[node_id] = {'parent_id': parent['id'] if parent else None, 'name': name, 'category': category, 'depth': depth}
    edepth_of[node_id].add(depth)
print("enzyme brite nodes:", len(ebrite), " A-D lines failing regex:", len(regex_fail), regex_fail[:5], " nameless:", nameless)
print("ids at >1 depth:", [k for k, v in edepth_of.items() if len(v) > 1])
bad_depth = [k for k, v in ebrite.items() if v['depth'] != len(k.split('.'))]
print("nodes whose BRITE depth != number of EC components:", bad_depth[:10])
print("TRANSFERRED_EC resolution against live ko01000:")
for old, new in TRANSFERRED_EC.items():
    print(f"  {old:10s} -> {new:10s} target in brite: {new in ebrite!s:5s} resolve_or_drop_ec -> {resolve_or_drop_ec(old, ebrite)}")
print("  7.2.4.8 ->", resolve_or_drop_ec('7.2.4.8', ebrite), "   3.6.3 in brite:", '3.6.3' in ebrite, "   3.6.3.- ->", resolve_or_drop_ec('3.6.3.-', ebrite))
erows = list(iter_enzyme_path_rows(ko01000, set(ebrite)))
efp = collections.Counter(r['full_path'] for r in erows)
print("enzyme_paths rows:", len(erows), " dup full_path:", [p for p, n in efp.items() if n > 1][:5])
