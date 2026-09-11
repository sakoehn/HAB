"""
migrate_correlations_to_sql.py
================================
Populates the `correlations` table (see create_sql_schema.py) by walking
every qualifying pair of annotations in `annotation_catalog` and scoring
their Spearman-rank correlation, same statistical approach as
api/correlation.py's live /annotations/correlate endpoint -- CLR
pre-processing, a 9-lag search window, circular block-shift permutation
p-value -- but with the lag-search bias fixed (see corrected_pvalue below)
and run once as a batch job instead of per-request.

Vector source is `annotation_series` directly (egc per source/sample/
annotation_id), NOT api.index's _EGC_MATRIX / get_egc_vectors_from_matrix --
that path depends on build_search_index(build_matrices=True), which reads
the raw per-sample JSON files from disk. annotation_series already has the
same per-sample values in SQL, so this script has no JSON-backend
dependency at all.

Scope decision (see project memory, 2026-08-14): taxonomy candidates are
restricted to genus-and-coarser (depth <= 6 in annotation_series, where
1=domain..8=strain) -- strain+species alone are ~89% of taxonomy's 60,235
annotations, and including them blows the candidate-pair count up to
~3.3 billion. Revisit by changing TAXONOMY_DEPTH_CUTOFF below; this is a
filter, not a schema change.

Run:
    python scripts/migrate_correlations_to_sql.py
"""

import itertools
import os
import random
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import (  # pylint: disable=wrong-import-position,import-error
    SQLITE_DB_PATH,
    CORRELATION_LAGS,
    PERMUTATION_N,
    PERMUTATION_SEED,
)
from api.correlation import (  # pylint: disable=wrong-import-position,import-error
    _rank,
    _spearman_from_ranks,
    _spearman_at_lags,
    _clr_detrend,
)
from api.index import timepoint_sort_key  # pylint: disable=wrong-import-position,import-error


# R_THRESHOLD values match the inline logic in correlation.py's
# correlate_annotations (R_THRESHOLD = 0.2 if mode == "cross" else 0.3) --
# duplicated here as a named constant since this script has no single
# request-scoped `mode` variable to branch on inline.
R_THRESHOLD = {"cross": 0.2, "within": 0.3}

# Genus-and-coarser cutoff.
TAXONOMY_DEPTH_CUTOFF = 6

SOURCES = ["cog", "enzyme", "kegg", "taxonomy"]


def load_sample_order(conn: sqlite3.Connection) -> list[str]:
    """Return every distinct sample name from annotation_series, sorted
    chronologically (timepoint_sort_key, NOT plain string sort -- raw JGI
    timepoint strings are unpadded, e.g. "5/28/21 1:00" vs "13:00")."""
    flat_rows = []
    cursor = conn.execute("SELECT DISTINCT sample FROM annotation_series")
    rows = cursor.fetchall()
    for row in rows:
        flat_rows.append(row[0])
    return sorted(flat_rows, key=timepoint_sort_key)


def load_vector(
    conn: sqlite3.Connection,
    source: str,
    annotation_id: str,
    sample_order: list[str],
    metric: str
) -> list[float | None]:
    """One annotation's raw egc/norm_egc values from annotation_series,
    aligned index-for-index to sample_order (None where that sample has no
    row for this annotation)."""
    if metric == 'egc':
        query = "SELECT sample, egc FROM annotation_series WHERE annotation_id = ? AND source = ?"
    elif metric == 'norm_egc':
        query = "SELECT sample, norm_egc FROM annotation_series WHERE annotation_id = ? AND source = ?"
    else:
        raise ValueError(f"{metric} not found.")
    cursor = conn.execute(query, (annotation_id, source))
    rows = cursor.fetchall()
    result = {}
    for row in rows:
        result[row[0]] = row[1]
    final_result = []
    for tp in sample_order:
        if tp in result.keys():
            final_result.append(result[tp])
        else:
            final_result.append(None)
    return final_result


def load_catalog_lookup(conn: sqlite3.Connection) -> dict[tuple[str, str], int]:
    """Return {(source, annotation_id): catalog_id} for every row in
    annotation_catalog."""
    cursor = conn.execute("""
        SELECT source, annotation_id, id as catalog_id
        FROM annotation_catalog
    """)
    rows = cursor.fetchall()
    result = {}
    for row in rows:
        result[(row[0], row[1])] = row[2]
    return result


def load_taxonomy_depths(conn: sqlite3.Connection) -> dict[str, int]:
    """Return {annotation_id: depth} for source='taxonomy' rows in
    annotation_series (depth is constant per annotation_id within a
    source, so DISTINCT annotation_id/depth pairs is enough)."""
    cursor = conn.execute("""
        SELECT DISTINCT annotation_id, depth
        FROM annotation_series
        WHERE source = 'taxonomy'
    """)
    rows = cursor.fetchall()
    result = {}
    for row in rows:
        result[row[0]] = row[1]
    return result

def load_parent_lookup(conn: sqlite3.Connection) -> dict[tuple[str, str], str | None]:
    """Return {(source, annotation_id): parent} for every row in
    annotation_catalog -- used by iter_candidate_pairs' within-mode
    same-parent exclusion."""
    cursor = conn.execute(f"""
        SELECT source, annotation_id, parent, id AS catalog_id
        FROM annotation_catalog
    """)
    rows = cursor.fetchall()
    result = {}
    for row in rows:
        result[(row[0], row[1])] = row[2]
    return result

def iter_candidate_pairs(
    catalog_lookup: dict[tuple[str, str], int],
    parent_lookup: dict[tuple[str, str], str | None],
    taxonomy_depths: dict[str, int],
):
    """
    Generator (NOT a materialized list -- candidate count is ~373M with
    the taxonomy depth cutoff applied, ~3.3B without it) yielding
    (catalog_id_a, catalog_id_b, mode) for every pair that should be
    SCORED (not necessarily stored -- score_pair still applies
    R_THRESHOLD).

    Must apply, per the design discussion:
    - canonical ordering: catalog_id_a < catalog_id_b always
    - mode = 'within' for same-source pairs (excluding same-parent, see
      correlation.py's existing within-mode exclusion), 'cross' for
      different-source pairs
    - taxonomy depth filter: any taxonomy-source annotation in the pair
      must have depth <= TAXONOMY_DEPTH_CUTOFF
    """
    # Step 1: bucket eligible (catalog_id, parent) pairs by source.
    # Walk catalog_lookup once; for taxonomy entries, skip anything whose
    # depth (via taxonomy_depths) is over TAXONOMY_DEPTH_CUTOFF -- this is
    # the ONE place the genus-and-coarser cutoff actually gets enforced.
    by_source: dict[str, list[tuple[int, str | None]]] = {s: [] for s in SOURCES}
    for (source, annotation_id), catalog_id in catalog_lookup.items():
        if source == "taxonomy":
            if taxonomy_depths[annotation_id] > TAXONOMY_DEPTH_CUTOFF: continue
        parent = parent_lookup[(source, annotation_id)]
        by_source[source].append((catalog_id, parent))

    # Step 2: within-source pairs -- same bucket paired with itself.
    for source in SOURCES:
        for (catalog_id_x, parent_x), (catalog_id_y, parent_y) in itertools.combinations(by_source[source], 2):
            if parent_x and parent_y and parent_x == parent_y: continue
            if catalog_id_x < catalog_id_y:
                catalog_id_a = catalog_id_x
                catalog_id_b = catalog_id_y
            else:
                catalog_id_a = catalog_id_y
                catalog_id_b = catalog_id_x
            yield (catalog_id_a, catalog_id_b, "within")

    # Step 3: cross-source pairs -- every distinct pair of DIFFERENT
    # buckets, full product between them.
    for source_x, source_y in itertools.combinations(SOURCES, 2):
        for (catalog_id_x, _), (catalog_id_y, _) in itertools.product(by_source[source_x], by_source[source_y]):
            if catalog_id_x < catalog_id_y:
                catalog_id_a = catalog_id_x
                catalog_id_b = catalog_id_y
            else:
                catalog_id_a = catalog_id_y
                catalog_id_b = catalog_id_x
            yield (catalog_id_a, catalog_id_b, "cross")



def score_pair(
    clr_a: list[float],
    clr_b: list[float],
    raw_a: list[float | None],
    raw_b: list[float | None],
    mode: str,
) ->tuple[tuple[float, int, int], tuple[list[float], list[float]]] | None:
    """
    Pairwise-complete filter (drop timepoints where either raw value is
    None/0, same as correlation.py:479-489), then _spearman_at_lags over
    CORRELATION_LAGS. Returns (spearman_r, lag_samples, n_tps) if
    abs(spearman_r) clears R_THRESHOLD[mode] and n_tps >= 10, else None.
    """
    # Step 1: pairwise-complete filter -- keep clr_a[i]/clr_b[i] only at
    # indices where BOTH raw_a[i] and raw_b[i] are real (not None) and > 0.
    filtered_a = []
    filtered_b = []
    for i in range(len(raw_a)):
        if raw_a[i] is None or raw_a[i] <= 0 or raw_b[i] is None or raw_b[i] <= 0: continue
        filtered_a.append(clr_a[i])
        filtered_b.append(clr_b[i])

    # Step 2: floor check -- not enough real paired observations to trust.
    if len(filtered_a) < 10: return None

    # Step 3: lag search over the filtered CLR vectors.
    best_r, best_lag = _spearman_at_lags(filtered_a, filtered_b, CORRELATION_LAGS)
    if best_r is None: return None

    # Step 4: threshold check -- this is where `mode` picks 0.2 vs 0.3.
    if abs(best_r) < R_THRESHOLD[mode]: return None

    # Step 5: survived every filter -- return (spearman_r, lag_samples, n_tps).
    return ((best_r, best_lag, len(filtered_a)),(filtered_a, filtered_b))

def corrected_pvalue(
    ref: list[float],
    cand: list[float],
    observed_r: float,
    n_perm: int,
    rng_seed: int,
) -> float:
    """
    Circular block-shift permutation p-value -- but unlike
    correlation.py's _circular_shift_pvalue, re-searches the FULL
    CORRELATION_LAGS window on every one of the n_perm shifts instead of
    fixing the lag at the observed best. This is the bias fix from the
    2026-08-13 design discussion: comparing a best-of-9 observed
    statistic against a not-best-of-9 null understates the true p-value.
    Costs ~9x more per pair than correlation.py's version -- acceptable
    here since it runs once at population time, not per request.
    """
    n = len(ref)
    if n < 3: return 1.0

    rng = random.Random(rng_seed)
    cnt = 0

    # Re-search the full lag window on every shift (see docstring) --
    # this IS the bias fix, re-using the same _spearman_at_lags call the
    # observed pass already used in score_pair.
    for i in range(n_perm):
        shift = rng.randint(1, n-1)
        shifted_ref = ref[shift:] + ref[:shift]
        perm_r, perm_lag = _spearman_at_lags(shifted_ref, cand, CORRELATION_LAGS)
        if perm_r is not None and abs(perm_r) >= abs(observed_r):
            cnt += 1

    return cnt / n_perm

def populate_correlations(conn: sqlite3.Connection) -> None:
    """
    Driver: load sample order / vectors / catalog lookup / taxonomy
    depths once, then walk iter_candidate_pairs(), score each pair, and
    batch-insert qualifying rows into `correlations`. Insert in batches
    (executemany on a chunk, not one INSERT per row and not one giant
    list held in memory for all ~373M candidates -- see project memory on
    the mappings rebuild's real MemoryErrors from exactly this pattern).
    """
    sample_order = load_sample_order(conn)
    parent_lookup = load_parent_lookup(conn)
    tax_depth = load_taxonomy_depths(conn)
    catalog_lookup = load_catalog_lookup(conn)
    catalog_reverse = {}
    for k, v in catalog_lookup.items():
        catalog_reverse[v] = k

    # clr = log(val) - log(geometric mean of sample)
    cog = {}
    tax = {}
    kegg = {}
    enzy = {}
    for k, v in catalog_lookup.items():
        if k[0] == 'cog':
            cog[k[1]] = load_vector(conn, 'cog', k[1], sample_order=sample_order, metric='egc')
        elif k[0] == 'taxonomy':
            tax[k[1]] = load_vector(conn, 'taxonomy', k[1], sample_order=sample_order, metric='egc')
        elif k[0] == 'kegg':
            kegg[k[1]] = load_vector(conn, 'kegg', k[1], sample_order=sample_order, metric='egc')
        else:
            enzy[k[1]] = load_vector(conn, 'enzyme', k[1], sample_order=sample_order, metric='egc')

    clr_by_source = {}
    clr_by_source['cog'] = _clr_detrend(cog, len(sample_order))
    clr_by_source['taxonomy'] = _clr_detrend(tax, len(sample_order))
    clr_by_source['kegg'] = _clr_detrend(kegg, len(sample_order))
    clr_by_source['enzyme'] = _clr_detrend(enzy, len(sample_order))

    # score_pair needs BOTH raw and clr vectors
    raw_by_source = {"cog": cog, "taxonomy": tax, "kegg": kegg, "enzyme": enzy}

    INSERT_SQL = """
        INSERT INTO correlations
            (catalog_id_a, catalog_id_b, mode, spearman_r, lag_samples, p_value, n_tps)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    BATCH_SIZE = 5000
    batch = []

    for catalog_id_a, catalog_id_b, mode in iter_candidate_pairs(catalog_lookup, parent_lookup, tax_depth):
        source_a, annotation_id_a = catalog_reverse[catalog_id_a]
        source_b, annotation_id_b = catalog_reverse[catalog_id_b]

        raw_a = raw_by_source[source_a][annotation_id_a]
        clr_a = clr_by_source[source_a][annotation_id_a]
        raw_b = raw_by_source[source_b][annotation_id_b]
        clr_b = clr_by_source[source_b][annotation_id_b]


        result = score_pair(clr_a, clr_b, raw_a, raw_b, mode)
        if result is None: continue

        (r, lag, n_tps), (filtered_a, filtered_b) = result

        p_value = corrected_pvalue(filtered_a, filtered_b, r, PERMUTATION_N, PERMUTATION_SEED)

        batch.append((catalog_id_a, catalog_id_b, mode, r, lag, p_value, n_tps))

        if len(batch) >= BATCH_SIZE:
            conn.executemany(INSERT_SQL, batch)
            batch = []

    # Flush whatever's left after the loop ends
    if batch: conn.executemany(INSERT_SQL, batch)


def main() -> None:
    """Populate the correlations table and commit."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        populate_correlations(conn)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()