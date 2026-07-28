"""
prototype_trigram_search.py
------------------------------
Phase 1 (search decision spike) steps 3-4: adds trigrams to
annotation_catalog, implements a Mongo-trigram-backed search replicating
the real current algorithm (api/index.py search_index() + the relevance
scoring in api/routes.py's /search/annotations), and measures it against
the golden query fixture built by build_golden_search_queries.py.

Design (per MONGODB_MIGRATION_FOLLOWUP.md "Mongo Without mongot"):
  1. Precompute 3-character trigrams for every catalog document's
     annotation_id + name, store as an indexed array field.
  2. At query time, find candidate documents sharing ANY trigram with ANY
     query token (a superset -- guaranteed not to miss real matches in
     either substring direction; see script comments for why "any" is
     required instead of "all").
  3. Verify exact substring/token semantics and compute relevance tiers
     in Python over the (small) candidate set -- correctness comes from
     this step, not from trigram precision.
  4. Queries with any token under 3 characters skip the trigram index
     entirely (bounded full scan over the ~81K-document catalog --
     cheap now that it's this small).

Usage (from FastAPI/):
    python scripts/prototype_trigram_search.py
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import ASCENDING, MongoClient

from api.config import MONGO_URI, MONGO_DB_NAME

DATASET_VERSION = "2026-07-28-01"
GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "golden_search_queries.json")


def compute_trigrams(text: str) -> list[str]:
    text = (text or "").lower()
    if len(text) < 3:
        return [text] if text else []
    return list({text[i:i + 3] for i in range(len(text) - 2)})


def has_short_token(doc: dict) -> bool:
    words = f"{doc['annotation_id']} {doc.get('name') or ''}".split()
    return any(len(w) <= 2 for w in words)


def add_trigrams(db):
    print("Adding trigrams to annotation_catalog...")
    cursor = db.annotation_catalog.find({"dataset_version": DATASET_VERSION})
    updated = 0
    for doc in cursor:
        searchable = f"{doc['annotation_id']} {doc.get('name') or ''}"
        trigrams = compute_trigrams(searchable)
        db.annotation_catalog.update_one(
            {"_id": doc["_id"]},
            {"$set": {"trigrams": trigrams, "has_short_token": has_short_token(doc)}},
        )
        updated += 1
        if updated % 20000 == 0:
            print(f"  {updated} documents...")
    print(f"Done. Updated {updated} documents.")

    name = db.annotation_catalog.create_index([("trigrams", ASCENDING)])
    print(f"Created/confirmed trigram index: {name}")
    name2 = db.annotation_catalog.create_index([("has_short_token", ASCENDING)])
    print(f"Created/confirmed has_short_token index: {name2}")


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in (text or "").split() if t]


def doc_tokens(doc: dict) -> list[str]:
    tokens = tokenize(doc["annotation_id"]) + tokenize(doc.get("name") or "")
    tokens.append(doc["annotation_id"].lower())
    return tokens


def doc_matches_query_token(doc: dict, query_token: str) -> bool:
    return any(query_token in dt or dt in query_token for dt in doc_tokens(doc))


def search_catalog(db, source: str, q: str | None, annotation_id: str | None, name_exact: str | None):
    """Replicates the real /search/annotations logic (both the q-based
    token search and the annotation_id/name_exact exact-match paths)
    against annotation_catalog via trigram-narrowed candidates."""
    base_filter = {"dataset_version": DATASET_VERSION, "source": source}

    if annotation_id:
        doc = db.annotation_catalog.find_one({**base_filter, "annotation_id": annotation_id})
        candidates = [doc] if doc else []
    elif q:
        q_tokens = q.lower().strip().split()
        # A short query token (<3 chars) has no 3-gram of its own to look
        # up, so it can't be narrowed by trigram overlap -- fall back to a
        # full scan, cheap now that the catalog is ~81K docs. Separately, a
        # short INDEXED token (e.g. a bare "E" in a real name) can be a
        # substring of a longer query in a way trigram overlap can't detect
        # either, since the *document's* token has no 3-gram either -- so
        # any document flagged has_short_token must stay a candidate
        # regardless of trigram overlap with the query.
        if any(len(qt) < 3 for qt in q_tokens):
            candidates = list(db.annotation_catalog.find(base_filter))
        else:
            all_trigrams = set()
            for qt in q_tokens:
                all_trigrams.update(compute_trigrams(qt))
            candidates = list(db.annotation_catalog.find({
                **base_filter,
                "$or": [
                    {"trigrams": {"$in": list(all_trigrams)}},
                    {"has_short_token": True},
                ],
            }))

        candidates = [d for d in candidates if all(doc_matches_query_token(d, qt) for qt in q_tokens)]
    else:
        candidates = list(db.annotation_catalog.find(base_filter))

    if name_exact:
        name_lower = name_exact.lower()
        candidates = [d for d in candidates if (d.get("name") or "").lower() == name_lower]

    q_lower = q.lower().strip() if q else None
    results = []
    for doc in candidates:
        score = score_result(doc["annotation_id"], doc.get("name"), q_lower, annotation_id, name_exact)
        results.append((doc["source"], doc["annotation_id"], score, doc.get("mean_egc") or 0))

    return results


def score_result(ann_id: str, name: str | None, q_lower: str | None, annotation_id: str | None, name_exact: str | None) -> int:
    """Relevance-tier scoring, exactly mirroring routes.py's search_annotations()
    (lines ~552-565) -- shared so both the candidate scorer and the golden
    order-check recompute identical scores from the same rule set."""
    ann_id_lower = ann_id.lower()
    name_lower = (name or "").lower()
    score = 1
    if q_lower:
        if ann_id_lower == q_lower:
            score = 4
        elif name_lower == q_lower:
            score = 3
        elif ann_id_lower.startswith(q_lower) or q_lower in name_lower:
            score = 2
    elif annotation_id:
        score = 4
    elif name_exact:
        score = 3
    return score


def rank_results(results: list) -> list:
    """Global sort across all sources combined, mirroring routes.py's
    single results.sort() at the end of search_annotations() -- ranking
    must happen once across the whole combined set, not per source."""
    ranked = sorted(results, key=lambda r: (r[2], r[3]), reverse=True)
    return [(r[0], r[1]) for r in ranked]


def check_order(
    golden_ordered_ids: list, golden_mean_egcs: list, golden_names: list,
    proto_ids: list, q: str | None, annotation_id: str | None, name_exact: str | None,
) -> list[str]:
    """Verify proto_ids' relative order matches golden's wherever golden's
    own (score, mean_egc) sort key actually differs -- the FULL production
    sort key (routes.py: `(r["_score"], r["mean_egc"] or 0)`), not mean_egc
    alone. Recomputing score here (via the same score_result() the
    candidate scorer uses) matters: two golden entries can coincidentally
    share the same mean_egc while having different scores, and comparing
    mean_egc alone would wrongly treat that as a tie and skip a real,
    checkable violation.

    Genuine full-key ties ARE skipped: production's own tiebreak for equal
    (score, mean_egc) falls back to Python set-iteration order (search_index()
    returns a set[str]), which is not a designed/reproducible ordering, so
    treating a tie swap as a violation would be a false positive.
    Returns a list of human-readable violation descriptions (empty = OK)."""
    q_lower = q.lower().strip() if q else None
    proto_pos = {key: i for i, key in enumerate(proto_ids)}

    golden_keys = [tuple(x) for x in golden_ordered_ids]
    golden_sort_key = {}
    for (src, ann_id), egc, name in zip(golden_keys, golden_mean_egcs, golden_names):
        score = score_result(ann_id, name, q_lower, annotation_id, name_exact)
        golden_sort_key[(src, ann_id)] = (score, egc)

    violations = []
    n = len(golden_keys)
    for i in range(n):
        for j in range(i + 1, n):
            key_i, key_j = golden_keys[i], golden_keys[j]
            sk_i, sk_j = golden_sort_key[key_i], golden_sort_key[key_j]
            if sk_i == sk_j:
                continue  # genuine tie in production -- order not meaningful
            if key_i not in proto_pos or key_j not in proto_pos:
                continue  # membership mismatches are reported separately
            if proto_pos[key_i] > proto_pos[key_j]:
                violations.append(
                    f"{key_i} (score,mean_egc={sk_i}) should rank above {key_j} "
                    f"(score,mean_egc={sk_j}) but prototype has it ranked below"
                )
                if len(violations) >= 5:
                    return violations
    return violations


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    if not db.annotation_catalog.find_one(
        {"dataset_version": DATASET_VERSION, "trigrams": {"$exists": True}, "has_short_token": {"$exists": True}}
    ):
        add_trigrams(db)
    else:
        print("Trigrams already present, skipping build.")

    index_stats = db.command("collStats", "annotation_catalog")
    print(f"\nannotation_catalog total index size: {index_stats['totalIndexSize'] / (1024*1024):.2f} MB")
    for n, s in index_stats.get("indexSizes", {}).items():
        print(f"  {n}: {s / (1024*1024):.2f} MB")

    with open(GOLDEN_PATH) as f:
        golden = json.load(f)

    print(f"\n{'case':35s} {'golden':>8s} {'proto':>8s} {'match?':>8s} {'time':>8s}")
    all_passed = True
    for case in golden["cases"]:
        params = case["params"]
        sources = params.get("sources", [])
        if isinstance(sources, str):
            sources = [sources]

        start = time.monotonic()
        raw_results = []
        for source in sources:
            raw_results.extend(search_catalog(
                db, source,
                q=params.get("q"), annotation_id=params.get("annotation_id"), name_exact=params.get("name_exact"),
            ))
        proto_ids = rank_results(raw_results)
        elapsed = time.monotonic() - start

        golden_set = set(tuple(x) for x in case["ordered_ids"])
        proto_set = set(proto_ids)
        member_match = golden_set == proto_set
        order_violations = []
        if member_match and "mean_egcs" in case and "names" in case:
            order_violations = check_order(
                case["ordered_ids"], case["mean_egcs"], case["names"], proto_ids,
                q=params.get("q"), annotation_id=params.get("annotation_id"), name_exact=params.get("name_exact"),
            )

        match = member_match and not order_violations
        if not match:
            all_passed = False
            missing = golden_set - proto_set
            extra = proto_set - golden_set
            print(f"{case['name']:35s} {case.get('total', len(golden_set)):8d} {len(proto_set):8d} {'FAIL':>8s} {elapsed:7.3f}s")
            if missing:
                print(f"    missing (in golden, not in prototype): {list(missing)[:5]}")
            if extra:
                print(f"    extra (in prototype, not in golden): {list(extra)[:5]}")
            if order_violations:
                print(f"    ORDER violations ({len(order_violations)} shown, membership matched):")
                for v in order_violations:
                    print(f"      {v}")
        else:
            print(f"{case['name']:35s} {case.get('total', len(golden_set)):8d} {len(proto_set):8d} {'OK':>8s} {elapsed:7.3f}s")

    print()
    print("ALL GOLDEN CASES PASSED (membership + order)" if all_passed else "SOME CASES FAILED -- see above")

    client.close()


if __name__ == "__main__":
    main()
