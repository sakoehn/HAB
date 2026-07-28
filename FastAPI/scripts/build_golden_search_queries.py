"""
build_golden_search_queries.py
---------------------------------
Phase 1 (search decision spike) step 2: captures real current search
behavior from the live /search/annotations endpoint (DATA_BACKEND=json,
the actual production default) as a golden fixture. Any future search
implementation (MongoDB n-gram, manual trigram, Postgres pg_trgm, etc.)
must reproduce these exact result sets before it's trusted.

Each case is chosen to exercise one specific, verified real behavior of
api/index.py's search_index() + the relevance-scoring in
api/routes.py's /search/annotations -- not guessed examples. See
MONGODB_MIGRATION_FOLLOWUP.md "Preserve The Contract Before Choosing An
Engine" and project memory (2026-07-28 session) for why this exists.

Requires a live server on BASE_URL with DATA_BACKEND=json (or mongo, to
compare backends against each other using the same fixture).

Usage (from FastAPI/):
    python scripts/build_golden_search_queries.py
"""

import json
import os
import time
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("GOLDEN_BASE_URL", "http://127.0.0.1:8000")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "golden_search_queries.json")

CASES = [
    {
        "name": "exact_token_substring",
        "description": "Whole-word token match — baseline case.",
        "params": {"q": "synthase", "sources": "cog"},
    },
    {
        "name": "infix_prefix_within_word",
        "description": "Query is a prefix fragment of a longer indexed token "
                        "('synth' inside 'synthase') — proves substring "
                        "matching works within a word, not just whole tokens.",
        "params": {"q": "synth", "sources": "cog"},
    },
    {
        "name": "reverse_substring_key_in_query",
        "description": "Query is LONGER than the indexed token ('synthases' "
                        "vs indexed 'synthase') -- proves the 'key in token' "
                        "direction of matching is active, not just 'token in "
                        "key'. This is a real, verified behavior, not hypothetical.",
        "params": {"q": "synthases", "sources": "cog"},
    },
    {
        "name": "case_insensitive",
        "description": "Uppercase query must return identical results to "
                        "the lowercase version.",
        "params": {"q": "SYNTHASE", "sources": "cog"},
    },
    {
        "name": "multi_token_and",
        "description": "Two-word query — both tokens must match (AND), not "
                        "OR. 'atp synthase' should score real ATP synthase "
                        "subunit names at the top via the whole-phrase "
                        "substring-in-name relevance tier (score 2).",
        "params": {"q": "atp synthase", "sources": "cog"},
    },
    {
        "name": "exact_annotation_id",
        "description": "Exact ID match should score highest (tier 4) but "
                        "the result set is NOT just that one ID -- short "
                        "substrings of the query (e.g. 'co', 'g005') are "
                        "themselves indexed keys from unrelated annotations' "
                        "names, so they get swept in at lower tiers. This is "
                        "real, verified behavior, not a hypothetical.",
        "params": {"q": "COG0055", "sources": "cog"},
    },
    {
        "name": "id_prefix_no_exact_match",
        "description": "Prefix of several real IDs (COG0050-COG0059) with "
                        "no exact match itself -- exercises the "
                        "'annotation_id starts with query' tier-2 rule.",
        "params": {"q": "COG005", "sources": "cog"},
    },
    {
        "name": "single_character_query",
        "description": "Extreme short-query case -- matches nearly every "
                        "annotation via substring. Any replacement engine "
                        "needs an explicit policy for this (Mike's review: "
                        "'require 3+ chars for infix, or bounded fallback').",
        "params": {"q": "a", "sources": "cog"},
    },
    {
        "name": "no_match",
        "description": "Genuine zero-match query, verified: a repeated "
                        "character long enough to escape substring matching "
                        "in both directions. Note this is HARDER to achieve "
                        "than it sounds -- see "
                        "'surprising_substring_collision' below.",
        "params": {"q": "qqqqqqqqqqqqqq", "sources": "cog"},
    },
    {
        "name": "surprising_substring_collision",
        "description": "Looks like a nonsense query, but real behavior: "
                        "matches 139 results in production. 'A' is a "
                        "standalone whitespace-tokenized word in real names "
                        "like 'Arylsulfatase A or related enzyme' -- since "
                        "this query contains the letter 'a', the reverse-"
                        "substring rule (key-in-token) matches every "
                        "annotation with a bare single-letter word token "
                        "anywhere in its name. Verified: single letters "
                        "b/f/k/q/w/x/z each independently match 190-2457 "
                        "results on their own. This means almost no "
                        "alphabetic query can return zero results, not just "
                        "short ones -- a materially bigger problem than the "
                        "documented '1-2 character query' case alone.",
        "params": {"q": "zzzznotarealterm", "sources": "cog"},
    },
    {
        "name": "cross_source",
        "description": "Same query across all four sources in one request. "
                        "sources= is a repeated FastAPI list param "
                        "(?sources=a&sources=b), not comma-joined -- caught "
                        "as a real bug in this fixture script itself "
                        "(silently returned 0 results before the fix).",
        "params": {"q": "synthase", "sources": ["kegg", "cog", "enzyme", "taxonomy"]},
    },
    {
        "name": "exact_name_param",
        "description": "name_exact param (not q) -- separate code path, "
                        "always scores tier 3.",
        "params": {"name_exact": "FoF1-type ATP synthase, beta subunit", "sources": "cog"},
    },
    {
        "name": "annotation_id_param",
        "description": "annotation_id param (not q) -- separate code path, "
                        "exact membership check only, always scores tier 4.",
        "params": {"annotation_id": "COG0055", "sources": "cog"},
    },
]


def fetch_all_pages(params: dict, timeout: int = 120) -> tuple[list[dict], float]:
    """Search endpoint paginates; walk every page to get the true full result set.
    Returns (rows, elapsed_seconds) -- the real current search implementation
    is a linear scan (see api/index.py search_index()), so timing this is
    itself a useful Phase-1 measurement, not just a correctness check."""
    all_rows = []
    page = 1
    start = time.monotonic()
    while True:
        q = dict(params)
        q["page"] = page
        q["page_size"] = 500
        # doseq=True: a list value (e.g. sources=["cog","kegg"]) becomes
        # repeated ?sources=cog&sources=kegg, matching FastAPI's
        # `sources: list[str] = Query(...)` -- a single comma-joined string
        # is parsed as one invalid AnnotationSource value and silently
        # matches nothing.
        url = f"{BASE_URL}/search/annotations?{urllib.parse.urlencode(q, doseq=True)}"
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = json.loads(resp.read())
        rows = body.get("data", [])
        all_rows.extend(rows)
        if len(rows) < q["page_size"]:
            break
        page += 1
    return all_rows, time.monotonic() - start


def main():
    fixture = {"base_url": BASE_URL, "cases": []}

    for case in CASES:
        try:
            rows, elapsed = fetch_all_pages(case["params"])
        except Exception as e:
            print(f"{case['name']:35s} FAILED: {e}")
            fixture["cases"].append({
                "name": case["name"], "description": case["description"],
                "params": case["params"], "error": str(e),
            })
            continue

        ordered_ids = [(r["source"], r["annotation_id"]) for r in rows]
        mean_egcs = [r.get("mean_egc") for r in rows]
        names = [r.get("name") for r in rows]
        fixture["cases"].append({
            "name":            case["name"],
            "description":     case["description"],
            "params":          case["params"],
            "total":           len(ordered_ids),
            "elapsed_seconds": round(elapsed, 3),
            "ordered_ids":     ordered_ids,
            "mean_egcs":       mean_egcs,
            "names":           names,
            "top_5":           ordered_ids[:5],
        })
        print(f"{case['name']:35s} total={len(ordered_ids):6d}  time={elapsed:6.2f}s  top: {ordered_ids[:3]}")

    with open(OUTPUT_PATH, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"\nSaved {len(CASES)} golden cases to {os.path.abspath(OUTPUT_PATH)}")


if __name__ == "__main__":
    main()
