import math
import numpy as np
from scipy import stats
import os
import sqlite3
import sys
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import APIRouter, HTTPException, Query
from api.config import SQLITE_DB_PATH

from .cache import AnnotationSource
from .config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE
from scripts.migrate_correlations_to_sql import (
    load_vector,
    load_sample_order
)

router = APIRouter()

# ── Correlation result cache ──────────────────────────────────────────────────

_CORR_CACHE: dict[tuple, list] = {}


# ── Math primitives ───────────────────────────────────────────────────────────
def _rank(vec: list[float]):
    vec = np.array(vec)
    return stats.rankdata(vec)

def _spearman_from_ranks(ra: list[float], rb: list[float]):
    stat, pval = stats.pearsonr(ra, rb)
    return (stat, pval)

def _spearman(a: list[float], b: list[float]):
    if len(a) < 10: return None
    rank_a = _rank(a)
    rank_b = _rank(b)
    return _spearman_from_ranks(rank_a, rank_b)

def _spearman_at_lags(ref:  list[float], cand: list[float], lags: list[int], method: str):
    best_r = None
    best_lag = None
    best_p = None
    best_n = len(ref)
    n = len(ref)
    for lag in lags:
        if lag >= 0:
            a = ref[lag:]
            b = cand[:n - lag] if lag > 0 else cand
        else:
            a = ref[:n + lag]
            b = cand[-lag:]
        if len(a) < 10:
            continue
        core = core_scoring(a, b, method)
        if core is None: continue
        r, p, n_test = core[0], core[1], core[2]
        if r is None:
            continue
        if best_r is None or abs(r) > abs(best_r):
            best_r   = r
            best_lag = lag
            best_p = p
            best_n = n_test

    return (best_r, best_lag, best_p, best_n) if best_r is not None else (None, None, None, None)

def _bonferroni_correct(p: float, n_tests: int):
    return min(p * n_tests, 1.0)

def get_family_candidates(conn, ref_catalog_id, target_source):
    """
    Return every row in `target_source` eligible to be correlated against
    `ref_catalog_id`. Cross-source: everything, no exclusions. Same-source:
    excludes ref itself, its siblings (share ref's exact parent, NULL
    included -- except cog, which has no parent concept at all and is
    exempted below), and its ancestors/descendants at any depth.

    Returns a list of dicts: {"id": ..., "annotation_id": ..., "parent": ..., "name": ...}
    """
    cursor = conn.execute(
        "SELECT source, annotation_id, parent FROM annotation_catalog WHERE id = ?",
        (ref_catalog_id,),
    )
    ref_row = cursor.fetchone()
    if ref_row is None:
        return []
    ref_source, ref_annotation_id, ref_parent = ref_row

    cursor = conn.execute(
        "SELECT id, annotation_id, parent, name FROM annotation_catalog WHERE source = ?",
        (target_source,),
    )
    target_rows = cursor.fetchall()

    def _shape(rows):
        return [{"id": r[0], "annotation_id": r[1], "parent": r[2], "name": r[3]} for r in rows]

    if ref_source != target_source:
        return _shape(target_rows)

    excluded = {ref_annotation_id}

    if target_source != AnnotationSource.cog.value:
        by_id: dict = {}        # annotation_id -> parent
        children_of: dict = {}  # parent (NULL included) -> [annotation_id, ...]
        for _cat_id, annotation_id, parent, _name in target_rows:
            by_id[annotation_id] = parent
            children_of.setdefault(parent, []).append(annotation_id)

        # Ancestors: walk up from ref_parent.
        cur = ref_parent
        while cur is not None and cur not in excluded:
            excluded.add(cur)
            cur = by_id.get(cur)

        # Descendants: BFS down from ref_annotation_id.
        stack = [ref_annotation_id]
        while stack:
            node = stack.pop()
            for child in children_of.get(node, []):
                if child not in excluded:
                    excluded.add(child)
                    stack.append(child)

        # Siblings: everything else sharing ref's exact parent (NULL included).
        for sibling in children_of.get(ref_parent, []):
            excluded.add(sibling)

    return _shape(row for row in target_rows if row[1] not in excluded)


def _apply_fdr(scored_family: list[dict]) -> list[dict]:
    """
    Attach a Benjamini-Hochberg q-value to each entry in scored_family
    (a list of dicts each already carrying a Bonferroni-corrected "p" from
    Tier 1). q-value is a property of the whole family, not any single
    pair, so this must run fresh per request -- never cached.
    """
    if not scored_family:
        return []
    pvals = [entry["p"] for entry in scored_family]
    _reject, qvals, _, _ = multipletests(pvals, alpha=0.05, method="fdr_bh")
    for entry, q in zip(scored_family, qvals):
        entry["q"] = q
    return scored_family

# ── Helper Functions ───────────────────────────────────────────────────────────
def core_scoring(vec_a: list[float], vec_b: list[float], method: str):
    # filter
    a,b = [], []
    for i in range(len(vec_a)):
        if (vec_a[i] is None or vec_a[i] <= 0) or (vec_b[i] is None or vec_b[i] <= 0):
            continue
        a.append(vec_a[i])
        b.append(vec_b[i])
    if len(a)< 10: return None

    # compute
    if method == 'raw_pearson':
        r, pval = stats.pearsonr(a, b)
    elif method == 'log_pearson':
        log_a = [math.log(v) for v in a]
        log_b = [math.log(v) for v in b]
        r, pval = stats.pearsonr(log_a, log_b)
    elif method == 'spearman':
        spear = _spearman(a, b)
        if spear is not None:
            r = spear[0]
            pval = spear[1]
        else:
            return None
    else:
        raise ValueError(f"{method} not found.")
    return (r, pval, len(a))

def score_pair(ref: list[float], cand: list[float], method):
    best_r, best_lag, best_p, best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, method)
    if best_r is None or best_lag is None or best_p is None: return None
    bonf_p = _bonferroni_correct(best_p, len(CORRELATION_LAGS))
    return best_r, bonf_p, best_lag, best_n

# ── Internal: Tier 1 read-through cache ─────────────────────────
def _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method):
    # 1. canonicalize catalog_id_a/catalog_id_b -> low, high (numeric compare)
    low, high = None, None
    if catalog_id_a <= catalog_id_b:
        low = catalog_id_a
        high = catalog_id_b
    elif catalog_id_b < catalog_id_a:
        low = catalog_id_b
        high = catalog_id_a
    cursor = conn.execute(f"""
            SELECT *
            FROM correlations_cache
            WHERE catalog_id_a = ? AND catalog_id_b = ? AND metric = ? AND method = ?
    """, (low, high, metric, method))
    row = cursor.fetchone()
    if row: 
    # 3. if a row came back: build the {r, lag_samples, p_value, n_pairs} dict
    #    from the correct column indices, return it -- done, nothing below runs
        return {'r': row[3], 'p': row[7], 'lag_samples': row[6], 'n_pairs': row[8] }
    else:
        query_can = "SELECT source, annotation_id FROM annotation_catalog WHERE id = ?"
        cursor_low = conn.execute(query_can, (low,))
        row_low = cursor_low.fetchone()
        cursor_high = conn.execute(query_can, (high,))
        row_high = cursor_high.fetchone()
        sample_order = load_sample_order(conn)
        vec_low = load_vector(conn, row_low[0], row_low[1], sample_order, metric)
        vec_high = load_vector(conn, row_high[0], row_high[1], sample_order, metric)
        result = score_pair(vec_low, vec_high, method)

        if result is None: return None # idk what is best to return here
        r, bonf_p, lag, n_pairs = result[0], result[1], result[2], result[3]
        cursor = conn.execute(f"""
            INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric,
            method, lag_samples, p_value, n_pairs)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (low, high, r, metric, method, lag, bonf_p, n_pairs))
        conn.commit()
        return {'r': r, 'p': bonf_p, 'lag_samples': lag, 'n_pairs': n_pairs}



# ── Endpoint: thin HTTP wrapper ──────────────────────────────────
@router.get("/correlation")
def correlate_endpoint(catalog_id_a: int, catalog_id_b: int, metric: str, method: str):
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        result = _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method)
    finally:
        conn.close()
    return result


# ── Endpoint: Tier 2, family + FDR ────────────────────────────────
@router.get("/correlations/family")
def correlation_family_endpoint(ref_source: str, ref_annotation_id: str, target_source: str, metric: str, method: str):
    valid_sources = {s.value for s in AnnotationSource}
    if target_source not in valid_sources:
        raise HTTPException(status_code=400, detail=f"target_source must be one of {valid_sources}")

    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        ref_row = conn.execute(
            "SELECT id FROM annotation_catalog WHERE source = ? AND annotation_id = ?",
            (ref_source, ref_annotation_id),
        ).fetchone()
        if ref_row is None:
            raise HTTPException(status_code=404, detail="Unknown (source, annotation_id) pair")
        ref_catalog_id = ref_row[0]

        candidates = get_family_candidates(conn, ref_catalog_id, target_source)

        scored = []
        for cand in candidates:
            result = _get_or_compute_correlation(conn, ref_catalog_id, cand["id"], metric, method)
            if result is None:
                continue
            scored.append({
                "catalog_id":    cand["id"],
                "annotation_id": cand["annotation_id"],
                "name":          cand["name"],
                "r":             result["r"],
                "p":             result["p"],
                "lag_samples":   result["lag_samples"],
                "lag_hours":     result["lag_samples"] * LAG_HOURS_PER_SAMPLE,
                "n_pairs":       result["n_pairs"],
            })

        scored = _apply_fdr(scored)
        return [entry for entry in scored if entry["q"] < 0.05]
    finally:
        conn.close()



