import math
import numpy as np
import random
import threading
from scipy import stats
import os
import sqlite3
import sys
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import APIRouter, HTTPException, Query
from api.config import SQLITE_DB_PATH

from .cache import AnnotationSource
from .cache_sql import _kegg_node_depth, KEGG_LEVEL_COLUMNS
from .config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE, PERMUTATION_N, PERMUTATION_SEED
from .correlation_loaders import (
    load_vector,
    load_sample_order,
    TAXONOMY_DEPTH_CUTOFF,
)

router = APIRouter()

# ── Correlation result cache ──────────────────────────────────────────────────

_CORR_CACHE: dict[tuple, list] = {}

# ── Per-family compute lock ───────────────────────────────────────────────────
# correlation_family_endpoint is a synchronous route, run in FastAPI's
# thread pool -- a slow (circular_shift) request that outlives its own
# client-side timeout keeps running in its thread regardless, which is
# what makes the frontend's auto-retry-on-timeout useful in the first
# place. But without this lock, each retry's thread ALSO starts its own
# full scoring loop over the same family, so N concurrent
# attempts/retries for the identical (ref, target, metric, method)
# redundantly recompute the same still-uncached candidates in parallel --
# competing for CPU rather than helping. Confirmed happening in practice
# (not just theoretical): after ~2 retries on a real circular_shift
# family, the process had 8 threads with real accumulated CPU time, and
# the per-candidate rate had roughly doubled (7.5s/candidate measured vs.
# 3.6s/candidate in isolation).
#
# A single process-wide dict of locks (not one global lock) so unrelated
# families can still compute concurrently -- only requests for the EXACT
# same family+method+metric serialize against each other. Correct for
# this app's actual deployment (a single uvicorn worker process, see
# reference_aws_deployment) -- would need a cross-process mechanism
# (e.g. a row in correlations_cache itself) if ever run with multiple
# worker processes.
_family_locks: dict[tuple, threading.Lock] = {}
_family_locks_guard = threading.Lock()


def _get_family_lock(key: tuple) -> threading.Lock:
    with _family_locks_guard:
        if key not in _family_locks:
            _family_locks[key] = threading.Lock()
        return _family_locks[key]


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

def _kegg_family_exclusions(conn, ref_annotation_id: str) -> set[str]:
    """
    CR3 (docs/AUDIT.md), the part left unresolved after switching `parent`
    to parent_id: annotation_catalog's `parent` column can only ever hold
    ONE of a KEGG node's real parents, but KEGG KOs are commonly
    multi-parent (K00844/hexokinase has 14 real parents -- see E14). The
    generic by_id/children_of walk below, which assumes one parent per
    node, silently misses every real ancestor/descendant relationship
    that isn't the one parent that happened to get recorded.

    `kegg_paths` (built for the BRITE hierarchy popup, see
    migrate_kegg_paths_to_sql.py) doesn't have this limitation -- it
    stores every real occurrence-path a node appears in, not just one.
    This walks that table instead, for KEGG only (verified: Enzyme and
    COG are single-parent by construction -- 0 of 7,333 real EC nodes and
    every COG id respectively have more than one real parent -- so the
    generic walk is already exactly correct for them; taxonomy's `parent`
    is a full lineage-prefix, never ambiguous either).

    Args:
        conn: Open SQLite connection.
        ref_annotation_id: The KEGG node to build the exclusion set for.

    Returns:
        Set of annotation_ids to exclude: ref itself, every real ancestor
        and descendant across every occurrence-path ref appears in, and
        every real sibling (shares at least one of ref's real immediate
        parents -- or, for a depth=1 ref, every other real depth=1 id,
        matching the generic walk's NULL-shared-parent convention for
        top-level nodes with nothing above them).
    """
    excluded = {ref_annotation_id}
    depth = _kegg_node_depth(conn, ref_annotation_id)
    if depth is None:
        return excluded  # not a real kegg_paths node -- no relationships to exclude

    level_col, _ = KEGG_LEVEL_COLUMNS[depth]
    rows = conn.execute(
        f"SELECT a_id, b_id, c_id, d_id FROM kegg_paths WHERE {level_col} = ?", (ref_annotation_id,)
    ).fetchall()

    # Ancestors + descendants: every real id in ANY column of ANY
    # occurrence-path ref appears in -- correct regardless of how many
    # real parents ref (or anything above/below it) has, since each row
    # is already a full A->B->C->D path, not a single parent pointer.
    for row in rows:
        excluded.update(value for value in row if value is not None)

    if depth == 1:
        top_level_ids = conn.execute("SELECT DISTINCT a_id FROM kegg_paths WHERE a_id IS NOT NULL").fetchall()
        excluded.update(r[0] for r in top_level_ids)
    else:
        parent_col_index = depth - 2  # (a_id, b_id, c_id, d_id) index of the column one level shallower
        real_parents = {row[parent_col_index] for row in rows if row[parent_col_index] is not None}
        if real_parents:
            parent_col, _ = KEGG_LEVEL_COLUMNS[depth - 1]
            placeholders = ",".join("?" * len(real_parents))
            siblings = conn.execute(
                f"SELECT DISTINCT {level_col} FROM kegg_paths WHERE {parent_col} IN ({placeholders})",
                tuple(real_parents),
            ).fetchall()
            excluded.update(r[0] for r in siblings if r[0] is not None)

    return excluded


def get_family_candidates(conn, ref_catalog_id, target_source):
    """
    Return every row in `target_source` eligible to be correlated against
    `ref_catalog_id`. Cross-source: everything, no exclusions. Same-source:
    excludes ref itself, its siblings (share ref's exact parent, NULL
    included), and its ancestors/descendants at any depth -- cog included
    (CR3, docs/AUDIT.md): E15 gave cog a real 2-level hierarchy, and
    migrate_annotations_to_sql.py now stores parent_id (not parent_name)
    for cog same as kegg/enzyme, so the same by_id/children_of tree-walk
    below works for it without a special case. kegg gets its own,
    different exclusion path (_kegg_family_exclusions above) since it's
    the one source where a node can have MULTIPLE real parents.

    Returns a list of dicts:
        {"id": ..., "annotation_id": ..., "parent": ..., "name": ..., "depth": ...}
    `depth` is the taxonomic rank (1=domain..8=strain) for taxonomy rows,
    source-specific pathway/EC hierarchy depth for kegg/enzyme, always
    None for cog (see annotation_catalog's own depth column docs).

    Taxonomy candidates are capped at genus-and-coarser (depth <=
    TAXONOMY_DEPTH_CUTOFF) -- species+strain alone are ~89% of taxonomy's
    ~60k annotations, and scoring against all of them made a cold family
    request take up to ~83 minutes. Same cutoff the old (abandoned)
    all-pairs batch job used for the same reason. Doesn't affect ref
    itself -- you can still ask "what correlates with this species,"
    just not get species/strain back as answers against a large family.
    """
    cursor = conn.execute(
        "SELECT source, annotation_id, parent FROM annotation_catalog WHERE id = ?",
        (ref_catalog_id,),
    )
    ref_row = cursor.fetchone()
    if ref_row is None:
        return []
    ref_source, ref_annotation_id, ref_parent = ref_row

    if target_source == AnnotationSource.taxonomy.value:
        cursor = conn.execute(
            "SELECT id, annotation_id, parent, name, depth FROM annotation_catalog "
            "WHERE source = ? AND depth <= ?",
            (target_source, TAXONOMY_DEPTH_CUTOFF),
        )
    else:
        cursor = conn.execute(
            "SELECT id, annotation_id, parent, name, depth FROM annotation_catalog WHERE source = ?",
            (target_source,),
        )
    target_rows = cursor.fetchall()

    def _shape(rows):
        return [
            {"id": r[0], "annotation_id": r[1], "parent": r[2], "name": r[3], "depth": r[4]}
            for r in rows
        ]

    if ref_source != target_source:
        return _shape(target_rows)

    if target_source == AnnotationSource.kegg.value:
        excluded = _kegg_family_exclusions(conn, ref_annotation_id)
        return _shape(row for row in target_rows if row[1] not in excluded)

    excluded = {ref_annotation_id}

    by_id: dict = {}        # annotation_id -> parent
    children_of: dict = {}  # parent (NULL included) -> [annotation_id, ...]
    for _cat_id, annotation_id, parent, _name, _depth in target_rows:
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
    if math.isnan(r) or math.isnan(pval):
        # A candidate with the same value at every co-observed timepoint
        # (zero variance) makes pearsonr return NaN for both r and p --
        # treat that exactly like "not enough data", not a real score.
        # Left unguarded, this NaN eventually hits correlations_cache's
        # NOT NULL columns: sqlite3 silently binds a NaN float as SQL
        # NULL, so the INSERT raises IntegrityError, the caller assumes a
        # concurrent-write race, and crashes re-reading a row that was
        # never written (see CR4).
        return None
    return (r, pval, len(a))

def _circular_shift_pvalue(ref: list[float | None], cand: list[float | None], observed_r: float, n_perm: int, seed: int) -> float:
    """
    Circular block-shift permutation p-value for CR2 (docs/AUDIT.md): the
    parametric p-value from scipy.stats.pearsonr assumes every timepoint
    is an independent observation, which real EGC series (sampled every
    4 hours) are not -- the effective sample size is far below the raw
    point count, so that p-value is systematically too optimistic
    (measured: ~51% of unrelated but autocorrelated pairs pass q<0.05).
    A circular shift preserves each series' own autocorrelation structure
    while destroying any real cross-series relationship, which is exactly
    the null this test needs.

    Re-searches the FULL CORRELATION_LAGS window on every one of n_perm
    shifts, instead of fixing the lag at the observed best -- comparing a
    best-of-9-lags observed statistic against a not-best-of-9 null
    understates the true p-value (the same lag-search bias the old,
    since-removed migrate_correlations_to_sql.py's corrected_pvalue was
    built to avoid). This also means the multi-lag multiplicity is
    already accounted for in the null itself -- the caller must NOT
    Bonferroni-correct this p-value afterward (see score_pair).

    Args:
        ref: Full aligned reference vector (raw values, None gaps
            included) -- NOT pre-filtered. Shifting must move the whole
            aligned series as a rigid block, gaps included, to keep its
            real autocorrelation structure intact; core_scoring's usual
            pairwise-complete filtering still runs per lag inside
            _spearman_at_lags on every shift.
        cand: Full aligned candidate vector, never shifted (only the
            reference is circularly shifted, matching the historical
            convention).
        observed_r: The real (unshifted) best-lag Spearman r, already
            computed by the caller.
        n_perm: Number of random circular shifts to try.
        seed: RNG seed, for reproducible p-values.

    Returns:
        Fraction of shifts whose best-of-9-lags |r| >= |observed_r|.
    """
    n = len(ref)
    if n < 3:
        return 1.0

    rng = random.Random(seed)
    count_as_extreme = 0
    for _ in range(n_perm):
        shift = rng.randint(1, n - 1)
        shifted_ref = ref[shift:] + ref[:shift]
        perm_r, _perm_lag, _perm_p, _perm_n = _spearman_at_lags(shifted_ref, cand, CORRELATION_LAGS, "spearman")
        if perm_r is not None and abs(perm_r) >= abs(observed_r):
            count_as_extreme += 1

    return count_as_extreme / n_perm


def score_pair(ref: list[float], cand: list[float], method):
    if method == "circular_shift":
        # Underlying r/lag statistic is always Spearman (rank-based,
        # robust to monotonic-but-nonlinear EGC relationships, matches
        # the historical convention this restores) -- CR2 is about fixing
        # the P-VALUE's validity, not about offering a 4th r-statistic.
        best_r, best_lag, _best_p, best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
        if best_r is None or best_lag is None:
            return None
        perm_p = _circular_shift_pvalue(ref, cand, best_r, PERMUTATION_N, PERMUTATION_SEED)
        return best_r, perm_p, best_lag, best_n

    best_r, best_lag, best_p, best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, method)
    if best_r is None or best_lag is None or best_p is None: return None
    bonf_p = _bonferroni_correct(best_p, len(CORRELATION_LAGS))
    return best_r, bonf_p, best_lag, best_n

# ── Internal: Tier 1 read-through cache ─────────────────────────
def _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method, get_sample_order=None):
    # 1. canonicalize catalog_id_a/catalog_id_b -> low, high (numeric compare)
    low, high = None, None
    if catalog_id_a <= catalog_id_b:
        low = catalog_id_a
        high = catalog_id_b
    elif catalog_id_b < catalog_id_a:
        low = catalog_id_b
        high = catalog_id_a

    reference_is_high = catalog_id_a > catalog_id_b

    cursor = conn.execute(f"""
            SELECT *
            FROM correlations_cache
            WHERE catalog_id_a = ? AND catalog_id_b = ? AND metric = ? AND method = ?
    """, (low, high, metric, method))
    row = cursor.fetchone()
    if row:

        lag = row[6]
        return {'r': row[3], 'p': row[7], 'lag_samples': -lag if reference_is_high else lag, 'n_pairs': row[8] }
    else:
        query_can = "SELECT source, annotation_id FROM annotation_catalog WHERE id = ?"
        cursor_low = conn.execute(query_can, (low,))
        row_low = cursor_low.fetchone()
        cursor_high = conn.execute(query_can, (high,))
        row_high = cursor_high.fetchone()
        sample_order = get_sample_order() if get_sample_order else load_sample_order(conn)
        vec_low = load_vector(conn, row_low[0], row_low[1], sample_order, metric)
        vec_high = load_vector(conn, row_high[0], row_high[1], sample_order, metric)
        result = score_pair(vec_low, vec_high, method)

        if result is None: return None # idk what is best to return here
        r, bonf_p, lag, n_pairs = result[0], result[1], result[2], result[3]
        try:
            conn.execute(f"""
                INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric,
                method, lag_samples, p_value, n_pairs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (low, high, r, metric, method, lag, bonf_p, n_pairs))
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            cursor = conn.execute(f"""
                SELECT * FROM correlations_cache
                WHERE catalog_id_a = ? AND catalog_id_b = ? AND metric = ? AND method = ?
            """, (low, high, metric, method))
            row = cursor.fetchone()
            if row is None:
                return None
            winner_lag = row[6]
            return {'r': row[3], 'p': row[7], 'lag_samples': -winner_lag if reference_is_high else winner_lag, 'n_pairs': row[8]}
        return {'r': r, 'p': bonf_p, 'lag_samples': -lag if reference_is_high else lag, 'n_pairs': n_pairs}



def _connect() -> sqlite3.Connection:
    """
    Open a connection with a busy timeout set, instead of sqlite3's default
    of failing instantly with "database is locked" the moment a second
    connection tries to write while another's write is still in-flight.

    Deliberately does NOT try to switch the db to WAL mode here -- WAL is a
    persistent, database-file-level setting (not a per-connection one), so
    it only needs to be set once, ever, for a given db file (see
    create_sql_schema.py, where it's applied as a one-time setup step, the
    same way the schema itself is). Tried doing it here first (guarded to
    only run once per process) and it was still wrong: switching journal
    mode itself requires no OTHER connection have a write transaction open
    -- a stricter condition than busy_timeout's normal wait-and-retry
    covers -- so the very first request after a restart could still race a
    concurrent writer and hit exactly the "database is locked" error this
    is supposed to prevent. Doing it once, deliberately, with nothing else
    connected (schema setup time) sidesteps that race entirely instead of
    trying to guard against it at request time.
    """
    conn = sqlite3.connect(SQLITE_DB_PATH)
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


# ── Endpoint: thin HTTP wrapper ──────────────────────────────────
@router.get("/correlation")
def correlate_endpoint(catalog_id_a: int, catalog_id_b: int, metric: str, method: str):
    conn = _connect()
    try:
        result = _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method)
    finally:
        conn.close()
    return result


# ── Endpoint: Tier 2, family + FDR ────────────────────────────────

# circular_shift is ~900x slower per candidate than a parametric method
# (measured: spearman 4ms/pair, circular_shift 3.6s/pair against the real
# db) -- a real family (measured against this database, COG0055 as
# reference) is 3,500-13,000 candidates, so running the full permutation
# test on every one of them is 3.5-13 hours even fully cold, longer than
# is practical to wait for even with retries. Pre-filtering to the
# strongest candidates by the fast method first, then running the
# expensive permutation test only on those, cuts that to minutes while
# only formally (permutation-)testing the candidates most likely to be
# real. This does change what the resulting q-values mean: they control
# the false discovery rate among the pre-filtered shortlist, not among
# the whole family -- disclosed via prescreened/prescreen_pool_size in
# the response so the frontend can show this, not hide it.
CIRCULAR_SHIFT_SCREEN_TOP_N = 200


@router.get("/correlations/family")
def correlation_family_endpoint(
    ref_source: str, ref_annotation_id: str, target_source: str, metric: str, method: str,
    limit: int = Query(50, ge=1, le=500),
):
    valid_sources = {s.value for s in AnnotationSource}
    if target_source not in valid_sources:
        raise HTTPException(status_code=400, detail=f"target_source must be one of {valid_sources}")

    conn = _connect()
    try:
        ref_row = conn.execute(
            "SELECT id FROM annotation_catalog WHERE source = ? AND annotation_id = ?",
            (ref_source, ref_annotation_id),
        ).fetchone()
        if ref_row is None:
            raise HTTPException(status_code=404, detail="Unknown (source, annotation_id) pair")
        ref_catalog_id = ref_row[0]

        candidates = get_family_candidates(conn, ref_catalog_id, target_source)

        # Memoized so it only runs (at most once) if some candidate in this
        # family is actually a cache miss -- an all-cache-hit family (the
        # steady-state case once Tier 1 is warm) never pays for it.
        _sample_order_box = []
        def get_sample_order():
            if not _sample_order_box:
                _sample_order_box.append(load_sample_order(conn))
            return _sample_order_box[0]

        prescreened = False
        prescreen_pool_size = None
        # Serializes concurrent/retried requests for this EXACT family so
        # they cooperate on the cache instead of redundantly recomputing
        # the same still-uncached candidates in parallel -- see
        # _get_family_lock's docstring. A waiter that blocks here and
        # then proceeds will find most or all candidates already cached
        # by whichever request got there first, so its own pass is fast.
        family_lock = _get_family_lock((ref_catalog_id, target_source, metric, method))
        with family_lock:
            if method == "circular_shift" and len(candidates) > CIRCULAR_SHIFT_SCREEN_TOP_N:
                prescreened = True
                prescreen_pool_size = len(candidates)
                fast_scored = []
                for cand in candidates:
                    result = _get_or_compute_correlation(
                        conn, ref_catalog_id, cand["id"], metric, "spearman", get_sample_order=get_sample_order,
                    )
                    if result is None:
                        continue
                    fast_scored.append((abs(result["r"]), cand))
                fast_scored.sort(key=lambda pair: pair[0], reverse=True)
                candidates = [cand for _abs_r, cand in fast_scored[:CIRCULAR_SHIFT_SCREEN_TOP_N]]

            scored = []
            for cand in candidates:
                result = _get_or_compute_correlation(
                    conn, ref_catalog_id, cand["id"], metric, method, get_sample_order=get_sample_order,
                )
                if result is None:
                    continue
                scored.append({
                    "catalog_id":    cand["id"],
                    "annotation_id": cand["annotation_id"],
                    "name":          cand["name"],
                    "depth":         cand["depth"],
                    "r":             result["r"],
                    "p":             result["p"],
                    "lag_samples":   result["lag_samples"],
                    "lag_hours":     result["lag_samples"] * LAG_HOURS_PER_SAMPLE,
                    "n_pairs":       result["n_pairs"],
                })

        scored = _apply_fdr(scored)
        significant = [entry for entry in scored if entry["q"] < 0.05]
        # CR5: results otherwise come back in catalog-id order (roughly
        # alphabetical by annotation id), not by match strength -- sort by
        # |r| descending and cap the list so the first screen is the
        # strongest correlates, not an arbitrary alphabetical slice.
        significant.sort(key=lambda entry: abs(entry["r"]), reverse=True)
        return {
            "results":             significant[:limit],
            "prescreened":         prescreened,
            "prescreen_pool_size": prescreen_pool_size,
            "prescreen_top_n":     CIRCULAR_SHIFT_SCREEN_TOP_N if prescreened else None,
        }
    finally:
        conn.close()



