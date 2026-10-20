import math
import numpy as np
import threading
import time
from scipy import stats
import os
import sqlite3
import sys
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import APIRouter, HTTPException, Query
from api.config import SQLITE_DB_PATH

from .cache import AnnotationSource
from .cache_sql import _kegg_node_depth, KEGG_LEVEL_COLUMNS, _cog_node_depth, COG_LEVEL_COLUMNS
from .config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE
from .correlation_loaders import (
    load_vector,
    load_sample_order,
    TAXONOMY_DEPTH_CUTOFF,
)

router = APIRouter()

# ── Input validation ──────────────────────────────────────────────────────────
# Both endpoints check method/metric against these allowlists up front and
# return 400 before doing any work. Otherwise a typo would only surface
# deep inside the per-candidate scoring loop (core_scoring / load_vector),
# as a 500 after a whole family's worth of computation.
VALID_METHODS = {"raw_pearson", "log_pearson", "spearman", "circular_shift"}
VALID_METRICS = {"egc", "norm_egc"}

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
# this app's actual deployment (a single uvicorn worker process) -- would
# need a cross-process mechanism (e.g. a row in correlations_cache itself)
# if ever run with multiple worker processes.
#
# _evict_idle_family_locks keeps this dict from growing by one entry per
# distinct family for the life of the process, but only ever removes an
# entry that's BOTH idle past the threshold AND not currently held
# (lock.locked() is False): a family lock already handed out to a
# waiting/running request must never be replaced by a second, different
# Lock object for the same key while that's still possible, or two
# concurrent requests for the same family could each acquire a
# DIFFERENT lock and run simultaneously -- exactly the redundant-work
# race this lock exists to prevent in the first place. Checked under
# the same _family_locks_guard _get_family_lock itself uses, so no
# request can be in the middle of being handed this exact lock while
# it's being considered for eviction.
_family_locks: dict[tuple, tuple[threading.Lock, float]] = {}  # key -> (lock, last_requested_at)
_family_locks_guard = threading.Lock()
_FAMILY_LOCKS_MAX_ENTRIES = 256
_FAMILY_LOCKS_IDLE_SECONDS = 60 * 60  # 1 hour


def _evict_idle_family_locks(now: float) -> None:
    """Must be called while holding _family_locks_guard. Only does
    anything once the dict has grown past the cap, so a normal-sized
    process pays nothing for this."""
    if len(_family_locks) <= _FAMILY_LOCKS_MAX_ENTRIES:
        return
    stale_keys = [
        key for key, (lock, last_requested_at) in _family_locks.items()
        if now - last_requested_at > _FAMILY_LOCKS_IDLE_SECONDS and not lock.locked()
    ]
    for key in stale_keys:
        del _family_locks[key]


def _get_family_lock(key: tuple) -> threading.Lock:
    with _family_locks_guard:
        now = time.time()
        entry = _family_locks.get(key)
        lock = entry[0] if entry is not None else threading.Lock()
        _family_locks[key] = (lock, now)
        _evict_idle_family_locks(now)
        return lock


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
    annotation_catalog's `parent` column can only hold ONE of a KEGG
    node's real parents, but KEGG KOs are commonly multi-parent
    (K00844/hexokinase has 14 real parents). The generic by_id/children_of
    walk in get_family_candidates assumes one parent per node, so it would
    miss every ancestor/descendant relationship except the one parent
    that happened to get recorded.

    `kegg_paths` (built for the BRITE hierarchy popup, see
    migrate_kegg_paths_to_sql.py) stores every real occurrence-path a node
    appears in, so this walks that table instead. COG has the same
    problem and gets the same treatment (_cog_family_exclusions); enzyme
    is single-parent by construction (0 of 7,333 real EC nodes have more
    than one parent) and taxonomy's `parent` is a full lineage prefix, so
    the generic walk is exact for both.

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


def _cog_family_exclusions(conn, ref_annotation_id: str) -> set[str]:
    """
    A COG id can belong to more than one category (340 real
    multi-category COGs, e.g. COG0028 is in both E and H), but
    annotation_catalog's `parent` column holds only one of them --
    migrate_annotations_to_sql.py fills it from EGC_COG_TREE.ipynb's
    `primary_cat_letter = categories[0]`. The generic one-parent walk in
    get_family_candidates would therefore exclude a multi-category COG's
    siblings in only ONE of its categories, returning the rest as if they
    were independent candidates.

    `cog_paths` (built for the hierarchy popup, see
    migrate_cog_paths_to_sql.py) stores every category a COG id belongs
    to. Same approach as _kegg_family_exclusions above, over COG's
    2-level (category, COG id) hierarchy instead of KEGG's 4.

    Args:
        conn: Open SQLite connection.
        ref_annotation_id: The COG node to build the exclusion set for.

    Returns:
        Set of annotation_ids to exclude: ref itself, every real
        ancestor/descendant across every real category ref belongs to,
        and every real sibling (shares at least one of ref's real
        categories -- or, for a category-letter ref, every other real
        category).
    """
    excluded = {ref_annotation_id}
    depth = _cog_node_depth(conn, ref_annotation_id)
    if depth is None:
        return excluded  # not a real cog_paths node -- no relationships to exclude

    level_col, _ = COG_LEVEL_COLUMNS[depth]
    rows = conn.execute(
        f"SELECT a_id, b_id FROM cog_paths WHERE {level_col} = ?", (ref_annotation_id,)
    ).fetchall()

    # Ancestors + descendants: every real id in ANY column of ANY
    # occurrence-path ref appears in -- correct regardless of how many
    # real categories ref belongs to, since each row is already a full
    # category->COG-id path, not a single parent pointer.
    for row in rows:
        excluded.update(value for value in row if value is not None)

    if depth == 1:
        top_level_ids = conn.execute("SELECT DISTINCT a_id FROM cog_paths WHERE a_id IS NOT NULL").fetchall()
        excluded.update(r[0] for r in top_level_ids)
    else:
        parent_col_index = depth - 2  # (a_id, b_id) index of the column one level shallower
        real_parents = {row[parent_col_index] for row in rows if row[parent_col_index] is not None}
        if real_parents:
            parent_col, _ = COG_LEVEL_COLUMNS[depth - 1]
            placeholders = ",".join("?" * len(real_parents))
            siblings = conn.execute(
                f"SELECT DISTINCT {level_col} FROM cog_paths WHERE {parent_col} IN ({placeholders})",
                tuple(real_parents),
            ).fetchall()
            excluded.update(r[0] for r in siblings if r[0] is not None)

    return excluded


def get_family_candidates(conn, ref_catalog_id, target_source):
    """
    Return every row in `target_source` eligible to be correlated against
    `ref_catalog_id`. Cross-source: everything, no exclusions. Same-source:
    excludes ref itself, its siblings (share ref's exact parent, NULL
    included), and its ancestors/descendants at any depth, via the generic
    by_id/children_of tree-walk below -- enzyme only now (single-parent by
    construction: 0 of 7,333 real EC nodes have more than one real
    parent). kegg and cog each get their own dedicated exclusion path
    (_kegg_family_exclusions / _cog_family_exclusions above) since both
    can have MULTIPLE real parents per node, which the single-value
    `parent` column the generic walk reads can't represent. Taxonomy gets
    its own ancestor-exclusion path too: the by_id tree-walk only sees
    ancestors shallower than TAXONOMY_DEPTH_CUTOFF, so it would stop short
    for a species/strain reference -- see the comment at the taxonomy
    branch below.

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

    if target_source == AnnotationSource.cog.value:
        excluded = _cog_family_exclusions(conn, ref_annotation_id)
        return _shape(row for row in target_rows if row[1] not in excluded)

    excluded = {ref_annotation_id}

    by_id: dict = {}        # annotation_id -> parent
    children_of: dict = {}  # parent (NULL included) -> [annotation_id, ...]
    for _cat_id, annotation_id, parent, _name, _depth in target_rows:
        by_id[annotation_id] = parent
        children_of.setdefault(parent, []).append(annotation_id)

    if target_source == AnnotationSource.taxonomy.value:
        # Walking ancestors via by_id (built only from target_rows, which is
        # itself capped at depth <= TAXONOMY_DEPTH_CUTOFF) would break for a
        # species/strain reference --
        # ref_parent's own depth already exceeds the cutoff, so it's not a
        # key in by_id and the walk stops immediately, leaving every real
        # ancestor (genus and coarser) unexcluded. A taxonomy annotation_id
        # IS its full ';'-joined lineage, so every real ancestor is exactly
        # a ';'-prefix of ref_annotation_id -- checking that directly finds
        # every ancestor regardless of ref's own depth, without relying on
        # the depth-truncated by_id map at all. Same trick as
        # frontend/src/utils/annotationHierarchy.ts's isTaxonomyDescendant,
        # mirrored for the ancestor direction.
        excluded |= {
            row[1] for row in target_rows
            if ref_annotation_id.startswith(row[1] + ';')
        }
    else:
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
        # never written.
        return None
    return (r, pval, len(a))

def _circular_shift_pvalue(ref: list[float | None], cand: list[float | None], observed_r: float) -> float:
    """
    Circular block-shift permutation p-value. The parametric p-value from
    scipy.stats.pearsonr assumes every timepoint
    is an independent observation, which real EGC series (sampled every
    4 hours) are not -- the effective sample size is far below the raw
    point count, so that p-value is systematically too optimistic
    (measured: ~51% of unrelated but autocorrelated pairs pass q<0.05).
    A circular shift preserves each series' own autocorrelation structure
    while destroying any real cross-series relationship, which is exactly
    the null this test needs.

    Re-searches the FULL CORRELATION_LAGS window on every shift, instead
    of fixing the lag at the observed best -- comparing a best-of-all-lags
    observed statistic against a single-lag null would understate the
    p-value. This also means the multi-lag multiplicity is already
    accounted for in the null itself -- the caller must NOT
    Bonferroni-correct this p-value afterward (see score_pair).

    Every shift in [2*max_lag+1, n-2*max_lag-1] is evaluated exactly once
    (no random sampling). Shifts closer to zero are excluded: the inner
    lag search can move the effective offset by up to max_lag in either
    direction, so a shift of max_lag+1 combined with an inner lag of
    -max_lag would land just 1 sample from the real alignment. Shifts
    where no lag has enough co-observed points to score are dropped from
    both numerator and denominator, and p is smoothed to
    (1 + extreme) / (1 + evaluable) so it is never exactly 0.

    Args:
        ref: Full aligned reference vector (raw values, None gaps
            included) -- NOT pre-filtered. Shifting must move the whole
            aligned series as a rigid block, gaps included, to keep its
            real autocorrelation structure intact; core_scoring's usual
            pairwise-complete filtering still runs per lag inside
            _spearman_at_lags on every shift.
        cand: Full aligned candidate vector, never shifted (only the
            reference is circularly shifted).
        observed_r: The real (unshifted) best-lag Spearman r, already
            computed by the caller.

    Returns:
        (p, at_floor) where p is (1 + #shifts at least as extreme as
        observed_r) / (1 + #evaluable shifts) -- "evaluable" excludes any
        shift where no lag had enough co-observed points to score -- and
        at_floor is True iff NO evaluated shift was as extreme as
        observed_r, meaning p is already the smallest value THIS PAIR's
        permutation test could possibly report (not a precise measurement
        close to zero). This floor is
        pair-specific, not a single dataset-wide constant: a sparse
        candidate (real EGC data ranges from ~1 to 128 of 128 samples
        detected, confirmed directly across all four annotation sources)
        has fewer evaluable shifts and therefore a COARSER (larger) floor
        than a fully-detected one, so this can't be approximated from n
        alone -- it has to be reported per pair. (p=1.0, at_floor=False)
        if no shift in the valid range was evaluable at all (series too
        short for this null to mean anything, e.g. n <= 4*max_lag + 1).
    """
    n = len(ref)
    max_lag = max(abs(lag) for lag in CORRELATION_LAGS)
    # Inclusive bounds on a valid shift: 2*max_lag, not max_lag, because the
    # inner lag-search below can itself move the effective offset by up to
    # max_lag in either direction (see the docstring).
    lo, hi = 2 * max_lag + 1, n - 2 * max_lag - 1
    if lo > hi:
        return 1.0, False

    count_as_extreme = 0
    evaluable = 0
    for shift in range(lo, hi + 1):
        shifted_ref = ref[shift:] + ref[:shift]
        perm_r, _perm_lag, _perm_p, _perm_n = _spearman_at_lags(shifted_ref, cand, CORRELATION_LAGS, "spearman")
        if perm_r is None:
            continue
        evaluable += 1
        if abs(perm_r) >= abs(observed_r):
            count_as_extreme += 1

    if evaluable == 0:
        return 1.0, False
    return (1 + count_as_extreme) / (1 + evaluable), count_as_extreme == 0


def score_pair(ref: list[float], cand: list[float], method):
    """Returns (r, p, lag, n_pairs, at_p_floor). at_p_floor is only ever
    meaningful for method='circular_shift' (whether p was forced to this
    pair's permutation-test resolution limit, not a precise
    measurement) -- always None for every
    parametric method, which has no such floor."""
    if method == "circular_shift":
        # Underlying r/lag statistic is always Spearman (rank-based,
        # robust to monotonic-but-nonlinear EGC relationships) --
        # circular_shift changes how the P-VALUE is computed, not which
        # correlation statistic is used.
        best_r, best_lag, _best_p, best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
        if best_r is None or best_lag is None:
            return None
        perm_p, at_p_floor = _circular_shift_pvalue(ref, cand, best_r)
        return best_r, perm_p, best_lag, best_n, at_p_floor

    best_r, best_lag, best_p, best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, method)
    if best_r is None or best_lag is None or best_p is None: return None
    bonf_p = _bonferroni_correct(best_p, len(CORRELATION_LAGS))
    return best_r, bonf_p, best_lag, best_n, None

# ── Internal: Tier 1 read-through cache ─────────────────────────
def _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method, get_sample_order=None, get_vector=None):
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
        # row[9] (at_p_floor) is NULL for every non-circular_shift row and
        # for any circular_shift row cached before this column existed --
        # genuinely unknown in both cases, kept as None rather than guessed.
        at_p_floor = bool(row[9]) if row[9] is not None else None
        return {'r': row[3], 'p': row[7], 'lag_samples': -lag if reference_is_high else lag, 'n_pairs': row[8], 'at_p_floor': at_p_floor}
    else:
        query_can = "SELECT source, annotation_id FROM annotation_catalog WHERE id = ?"
        cursor_low = conn.execute(query_can, (low,))
        row_low = cursor_low.fetchone()
        cursor_high = conn.execute(query_can, (high,))
        row_high = cursor_high.fetchone()
        if get_vector:
            vec_low = get_vector(row_low[0], row_low[1])
            vec_high = get_vector(row_high[0], row_high[1])
        else:
            sample_order = get_sample_order() if get_sample_order else load_sample_order(conn)
            vec_low = load_vector(conn, row_low[0], row_low[1], sample_order, metric)
            vec_high = load_vector(conn, row_high[0], row_high[1], sample_order, metric)
        result = score_pair(vec_low, vec_high, method)

        if result is None: return None # idk what is best to return here
        r, bonf_p, lag, n_pairs, at_p_floor = result[0], result[1], result[2], result[3], result[4]
        try:
            conn.execute(f"""
                INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric,
                method, lag_samples, p_value, n_pairs, at_p_floor)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (low, high, r, metric, method, lag, bonf_p, n_pairs, at_p_floor))
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
            winner_at_p_floor = bool(row[9]) if row[9] is not None else None
            return {'r': row[3], 'p': row[7], 'lag_samples': -winner_lag if reference_is_high else winner_lag, 'n_pairs': row[8], 'at_p_floor': winner_at_p_floor}
        except sqlite3.OperationalError:
            # A lock-timeout mid-write (plausible against a ~60 GB db with a
            # large un-checkpointed WAL) must not propagate up through the
            # family endpoint's per-candidate loop -- that would 500 the
            # WHOLE request and discard every other candidate's
            # already-computed result. The cache write is best-effort: roll
            # back the failed write and still return the real result below.
            # It just won't be cached; a future request recomputes it.
            conn.rollback()
        return {'r': r, 'p': bonf_p, 'lag_samples': -lag if reference_is_high else lag, 'n_pairs': n_pairs, 'at_p_floor': at_p_floor}



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
    if metric not in VALID_METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {VALID_METRICS}")
    if method not in VALID_METHODS:
        raise HTTPException(status_code=400, detail=f"method must be one of {VALID_METHODS}")
    conn = _connect()
    try:
        result = _get_or_compute_correlation(conn, catalog_id_a, catalog_id_b, metric, method)
    finally:
        conn.close()
    return result


# ── Endpoint: Tier 2, family + FDR ────────────────────────────────

# circular_shift is ~120x slower per candidate than a parametric method
# (measured: spearman ~3ms/pair, circular_shift ~0.38s/pair against the
# real db) -- a real family (measured against this database, COG0055
# as reference) is 3,500-13,000 candidates, so running the full
# permutation test on every one of them is still ~22-82 minutes even
# fully cold, not instant. Pre-filtering to the
# strongest candidates by the fast method first, then running the
# expensive permutation test only on those, cuts that to minutes while
# only formally (permutation-)testing the candidates most likely to be
# real. This does change what the resulting q-values mean: they control
# the false discovery rate among the pre-filtered shortlist, not among
# the whole family -- disclosed via prescreened/prescreen_pool_size in
# the response so the frontend can show this, not hide it.
CIRCULAR_SHIFT_SCREEN_TOP_N = 200


def _prescreen_rank_key(r: float, n_pairs: int) -> float:
    """An n-aware ranking statistic for the prescreen shortlist below, so a sparse candidate's raw |r| can't
    crowd out a fully-sampled candidate's real signal just because raw
    |r| says nothing about how much data actually produced it.

    Measured on a real 3,197-candidate pool, ranking by raw |r| alone:
    86 of the 200 shortlisted candidates had fewer than 30 of 128 real
    data points (one admitted at n=10, |r|=0.661), while 2,037
    fully-sampled (n>=120) candidates were excluded entirely -- the
    strongest excluded one at |r|=0.5652, losing its slot by just 0.0016
    to that 10-point candidate.

    Fisher-z-style |r|*sqrt(n-3) increases with both |r| and n, so two candidates at the same |r|
    rank by sample size, and two at the same n still rank by |r| --
    reflecting how much evidence actually backs each candidate's
    correlation, not just its raw size. n_pairs is always >= 10 here
    (core_scoring's own floor), so n-3 is always a safe, positive
    sqrt argument.
    """
    return abs(r) * math.sqrt(n_pairs - 3)


@router.get("/correlations/family")
def correlation_family_endpoint(
    ref_source: str, ref_annotation_id: str, target_source: str, metric: str, method: str,
    limit: int = Query(50, ge=1, le=500),
):
    valid_sources = {s.value for s in AnnotationSource}
    if target_source not in valid_sources:
        raise HTTPException(status_code=400, detail=f"target_source must be one of {valid_sources}")
    if metric not in VALID_METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {VALID_METRICS}")
    if method not in VALID_METHODS:
        raise HTTPException(status_code=400, detail=f"method must be one of {VALID_METHODS}")

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
        # Memoized the same way as get_sample_order below, but keyed per
        # (source, annotation_id) -- without this, the REFERENCE
        # annotation's vector gets reloaded from annotation_series on
        # every single candidate iteration (it's one side of every pair
        # scored in this family), even though it's identical every time.
        # Found live in production, 2026-09-25: a single load_vector call
        # measured ~75ms on this instance's storage; across a
        # 12,863-candidate kegg family that's ~16 minutes of pure waste
        # reloading the same reference vector, on top of an already very
        # long prescreening pass (measured ~1.2 pairs/sec -- ~3 hours for
        # that family alone, well past the frontend's ~2h retry ceiling).
        _vector_cache: dict[tuple[str, str], list] = {}
        def get_vector(source: str, annotation_id: str) -> list:
            key = (source, annotation_id)
            if key not in _vector_cache:
                _vector_cache[key] = load_vector(conn, source, annotation_id, get_sample_order(), metric)
            return _vector_cache[key]

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
                        conn, ref_catalog_id, cand["id"], metric, "spearman",
                        get_sample_order=get_sample_order, get_vector=get_vector,
                    )
                    if result is None:
                        continue
                    fast_scored.append((_prescreen_rank_key(result["r"], result["n_pairs"]), cand))
                fast_scored.sort(key=lambda pair: pair[0], reverse=True)
                candidates = [cand for _rank_key, cand in fast_scored[:CIRCULAR_SHIFT_SCREEN_TOP_N]]

            scored = []
            for cand in candidates:
                result = _get_or_compute_correlation(
                    conn, ref_catalog_id, cand["id"], metric, method,
                    get_sample_order=get_sample_order, get_vector=get_vector,
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
                    # True means `p` above is this pair's permutation-test resolution limit,
                    # not a precise measurement -- None means unknown
                    # (non-circular_shift method, or cached before this
                    # disclosure existed). See _circular_shift_pvalue.
                    "at_p_floor":    result.get("at_p_floor"),
                })

        scored = _apply_fdr(scored)
        significant = [entry for entry in scored if entry["q"] < 0.05]
        # Results otherwise come back in catalog-id order (roughly
        # alphabetical by annotation id), not by match strength -- sort by
        # |r| descending and cap the list so the first screen is the
        # strongest correlates, not an arbitrary alphabetical slice.
        significant.sort(key=lambda entry: abs(entry["r"]), reverse=True)
        # significant_count is the real total BEFORE `limit` (default 50) is
        # applied, so the caller can tell "exactly 50 significant results"
        # from "3,000, showing the top 50" and the panel can show
        # "top N of {significant_count}" instead of just N.
        return {
            "results":           significant[:limit],
            "significant_count": len(significant),
            "prescreened":         prescreened,
            "prescreen_pool_size": prescreen_pool_size,
            "prescreen_top_n":     CIRCULAR_SHIFT_SCREEN_TOP_N if prescreened else None,
        }
    finally:
        conn.close()



