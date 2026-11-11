"""Save (or compare against) /search/annotations responses on the real db.
python x4_snapshot.py save | compare"""
import json, sys, time
from pathlib import Path
sys.path.insert(0, r"C:\Users\sakoehn\Desktop\JGI\FastAPI")
from fastapi.testclient import TestClient
from main import app

OUT = Path(__file__).with_name("x4_search_before.json")
ALL = ["cog", "kegg", "enzyme", "taxonomy"]
REQUESTS = [
    {"q": "synthase", "sources": ALL, "page": 1, "page_size": 25},
    {"q": "synthase", "sources": ALL, "page": 7, "page_size": 40},
    {"q": "protein", "sources": ALL, "page": 1, "page_size": 5000},
    {"q": "protein", "sources": ALL, "page": 2, "page_size": 5000},
    {"q": "Vibrio", "sources": ALL, "page": 1, "page_size": 100},
    {"q": "kinase", "sources": ["kegg"], "page": 3, "page_size": 25},
    {"q": "Bacteria", "sources": ["taxonomy"], "page": 1, "page_size": 500},
    {"q": "J", "sources": ALL, "page": 1, "page_size": 25},
    {"q": "EC:1.1.1.1", "sources": ALL, "page": 1, "page_size": 25},
    {"annotation_id": "K02703", "sources": ["kegg"], "page": 1, "page_size": 25},
    {"q": "a", "sources": ALL, "page": 1, "page_size": 500},
    {"q": "nosuchthing", "sources": ALL, "page": 1, "page_size": 25},
    {"q": "bac", "sources": ALL, "page": 1, "page_size": 25},
    {"q": "bac", "sources": ALL, "page": 3, "page_size": 5000},
    {"q": "sp.", "sources": ["taxonomy"], "page": 1, "page_size": 100},
]
with TestClient(app) as client:
    got = []
    for params in REQUESTS:
        t0 = time.perf_counter()
        body = client.get("/search/annotations", params=params).json()
        got.append({"params": params, "body": body, "seconds": round(time.perf_counter() - t0, 3)})
if sys.argv[1] == "save":
    OUT.write_text(json.dumps(got), encoding="utf-8")
    for g in got:
        print(f"saved {g['params']} -> total {g['body']['total']}, {len(g['body']['data'])} rows, {g['seconds']} s")
else:
    before = json.loads(OUT.read_text(encoding="utf-8"))
    for b, a in zip(before, got):
        same = b["body"] == a["body"]
        print(f"{'same' if same else 'DIFFERENT':9s} {a['params']}  {b['seconds']} s -> {a['seconds']} s")
    print("all identical:", all(b["body"] == a["body"] for b, a in zip(before, got)))
