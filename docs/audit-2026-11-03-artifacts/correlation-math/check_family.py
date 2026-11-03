import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, sqlite3
from api.correlation_sql import get_family_candidates
SCHEMA = """
CREATE TABLE annotation_catalog(id INTEGER PRIMARY KEY, source TEXT NOT NULL, annotation_id TEXT NOT NULL, name TEXT, parent TEXT, depth INTEGER, UNIQUE (source, annotation_id));
CREATE TABLE kegg_paths(id INTEGER PRIMARY KEY, a_id TEXT, a_name TEXT, b_id TEXT, b_name TEXT, c_id TEXT, c_name TEXT, d_id TEXT, d_name TEXT, full_path TEXT NOT NULL UNIQUE);
CREATE TABLE cog_paths(id INTEGER PRIMARY KEY, a_id TEXT, a_name TEXT, b_id TEXT, b_name TEXT, full_path TEXT NOT NULL UNIQUE);
"""
def fresh():
    c = sqlite3.connect(':memory:'); c.executescript(SCHEMA); return c
def ins(c, id, source, aid, parent=None, depth=None):
    c.execute("INSERT INTO annotation_catalog (id, source, annotation_id, name, parent, depth) VALUES (?,?,?,?,?,?)", (id, source, aid, aid, parent, depth))
def kp(c, *ids):
    ids = list(ids) + [None] * (4 - len(ids))
    c.execute("INSERT INTO kegg_paths (a_id,b_id,c_id,d_id,full_path) VALUES (?,?,?,?,?)", (*ids, '|'.join(i for i in ids if i)))
def cp(c, a, b=None):
    c.execute("INSERT INTO cog_paths (a_id,b_id,full_path) VALUES (?,?,?)", (a, b, '|'.join(i for i in (a, b) if i)))
def fam(c, ref, src): return sorted(x['annotation_id'] for x in get_family_candidates(c, ref, src))

def check(name, got, expected):
    ok = got == sorted(expected)
    print(('OK  ' if ok else 'FAIL'), name, '| got', got, '| expected', sorted(expected))

# 1. KEGG depth-1 ref
c = fresh()
for i, (aid, d) in enumerate([('A1',1),('A2',1),('B1',2),('B2',2),('C1',3),('C2',3),('K1',4),('K2',4)], 1): ins(c, i, 'kegg', aid, depth=d)
kp(c, 'A1','B1','C1','K1'); kp(c, 'A2','B2','C2','K2')
check('kegg depth-1 ref A1: other roots excluded (NULL-parent sibling rule), whole subtree excluded, A2 subtree kept',
      fam(c, 1, 'kegg'), ['B2','C2','K2'])

# 2. KEGG multi-parent B: B1 under A1 and A3; siblings under both excluded; nephew kept
c = fresh()
rows = [('A1',1),('A2',1),('A3',1),('B1',2),('B1a',2),('B3a',2),('B2a',2),('C1',3),('C1a',3),('K1',4),('K1a',4)]
for i,(aid,d) in enumerate(rows,1): ins(c,i,'kegg',aid,depth=d)
kp(c,'A1','B1','C1','K1'); kp(c,'A3','B1','C1','K1'); kp(c,'A1','B1a','C1a','K1a'); kp(c,'A3','B3a'); kp(c,'A2','B2a')
check('kegg depth-2 multi-parent ref B1: A1,A3 ancestors; B1a,B3a siblings; C1,K1 descendants excluded; A2,B2a kept; nephew C1a/K1a kept',
      fam(c, 4, 'kegg'), ['A2','B2a','C1a','K1a'])

# 3. KEGG KO ref in two pathways
c = fresh()
rows = [('A',1),('B',2),('P1',3),('P2',3),('P3',3),('K1',4),('K2',4),('K3',4),('K4',4)]
for i,(aid,d) in enumerate(rows,1): ins(c,i,'kegg',aid,depth=d)
kp(c,'A','B','P1','K1'); kp(c,'A','B','P2','K1'); kp(c,'A','B','P1','K2'); kp(c,'A','B','P2','K3'); kp(c,'A','B','P3','K4')
check('kegg KO ref K1 in P1+P2: A,B,P1,P2 ancestors; K2,K3 siblings excluded; cousin pathway P3 and its KO K4 kept',
      fam(c, 6, 'kegg'), ['P3','K4'])

# 4. KEGG pathway ref: nephew KO (under sibling pathway) kept; siblings excluded
check('kegg pathway ref P1: P2,P3 siblings; A,B ancestors; K1,K2 descendants excluded; K3 (only in P2) and K4 kept',
      fam(c, 3, 'kegg'), ['K3','K4'])

# 5. Enzyme generic walk: depth-1 ref with NULL parent
c = fresh()
rows = [('1',None,1),('2',None,1),('1.1','1',2),('1.2','1',2),('1.1.1','1.1',3),('2.1','2',2),('1.2.1','1.2',3)]
for i,(aid,p,d) in enumerate(rows,1): ins(c,i,'enzyme',aid,parent=p,depth=d)
check('enzyme depth-1 ref "1": "2" excluded as NULL-parent sibling; all descendants excluded; 2.1 kept', fam(c,1,'enzyme'), ['2.1'])
check('enzyme ref "1.1": parent 1, sibling 1.2, child 1.1.1 excluded; 2, 2.1, nephew 1.2.1 kept', fam(c,3,'enzyme'), ['2','2.1','1.2.1'])

# 6. Taxonomy domain ref + prefix safety
c = fresh()
rows = [('Bacteria',None,1),('Archaea',None,1),('Bacteria;Proteobacteria','Bacteria',2),('Bacteria;Proteo','Bacteria',2),
        ('Bacteria;Proteobacteria;X','Bacteria;Proteobacteria',3),('Archaea;Eury','Archaea',2)]
for i,(aid,p,d) in enumerate(rows,1): ins(c,i,'taxonomy',aid,parent=p,depth=d)
check('taxonomy domain ref Bacteria: Archaea excluded (NULL-parent sibling); subtree excluded; Archaea;Eury kept', fam(c,1,'taxonomy'), ['Archaea;Eury'])
check('taxonomy ref Bacteria;Proteobacteria;X: "Bacteria;Proteo" NOT treated as ancestor (";" guard); ancestors excluded; Archaea* kept',
      fam(c,5,'taxonomy'), ['Bacteria;Proteo','Archaea','Archaea;Eury'])

# 7. COG ref in two categories
c = fresh()
rows = [('E',1),('H',1),('K',1),('COG1',2),('COG2',2),('COG3',2),('COG4',2)]
for i,(aid,d) in enumerate(rows,1): ins(c,i,'cog',aid,depth=d)
cp(c,'E','COG1'); cp(c,'H','COG1'); cp(c,'E','COG2'); cp(c,'H','COG3'); cp(c,'K','COG4')
check('cog ref COG1 in E+H: E,H ancestors; COG2,COG3 siblings excluded; K, COG4 kept', fam(c,4,'cog'), ['K','COG4'])
check('cog category ref E: H,K other categories excluded; COG1,COG2 members excluded; COG3, COG4 kept', fam(c,1,'cog'), ['COG3','COG4'])

# 8. Cross-source: no exclusions, even same ids
c = fresh()
ins(c,1,'kegg','X',depth=1); ins(c,2,'cog','X',depth=1); ins(c,3,'cog','Y',depth=2)
cp(c,'X','Y')
check('cross-source kegg X -> cog: everything returned', fam(c,1,'cog'), ['X','Y'])

# 9. KEGG ref whose id is not in kegg_paths at all: self-exclusion only (silent)
c = fresh()
ins(c,1,'kegg','ko00010',depth=3); ins(c,2,'kegg','K1',depth=4); ins(c,3,'kegg','00010',depth=3)
kp(c,'A','B','00010','K1')
check('kegg ref id format mismatch (ko00010 vs 00010 in kegg_paths): NO relationship exclusions (child K1 returned)', fam(c,1,'kegg'), ['K1','00010'])
