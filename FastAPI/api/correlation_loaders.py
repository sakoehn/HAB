"""
correlation_loaders.py
========================
Shared data-loading helpers for the live correlation endpoints
(correlation_sql.py) -- sample ordering and per-annotation EGC/norm_egc
vectors read from `annotation_series`, plus the taxonomy candidate depth
cutoff.

Split out of the old migrate_correlations_to_sql.py (CR7, see
docs/AUDIT.md): that file was an abandoned all-pairs batch job writing to
a `correlations` table create_sql_schema.py drops and never recreates --
never actually run -- but the live endpoint imported these three names
from it, which made the dead job read as load-bearing. It wasn't; only
these three pieces were.
"""

import sqlite3

from .index import timepoint_sort_key

# Genus-and-coarser cutoff for taxonomy correlation candidates -- see
# get_family_candidates in correlation_sql.py. Strain+species alone are
# ~89% of taxonomy's ~60k annotations, and scoring against all of them
# made a cold family request take up to ~83 minutes.
TAXONOMY_DEPTH_CUTOFF = 6


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


def assert_sample_order_is_trustworthy(sample_order: list[str]) -> None:
    """
    One-time startup check (see main.py's lifespan) that every sample
    resolves to a real timepoint and no two distinct samples collide on
    the exact same one -- either failure lets correlation scoring fall
    back to an arbitrary tie order with no visible symptom (CR6, see
    docs/AUDIT.md).

    Deliberately NOT enforced inside load_sample_order itself: many tests
    intentionally score synthetic, non-resolving sample names against an
    isolated in-memory db, and the ones where the real time axis actually
    matters already pass their own get_sample_order override. This is a
    one-time guard against the REAL database at boot, not a per-call
    contract load_sample_order's every caller would have to satisfy.

    Deliberately does NOT require uniform 4-hour spacing between every
    consecutive pair, despite that being CR6's originally suggested fix --
    checked against the real 128-sample dataset before writing this, and
    real gaps of 8h and 12h exist from missing samples, so a hard "must be
    exactly 4h apart" assertion would false-positive on legitimate data
    and take the server down at boot. lag_hours (lag_samples *
    LAG_HOURS_PER_SAMPLE) is therefore only exact across a gap-free
    stretch of samples -- a known approximation, not something this
    function can fix without changing what lag_hours means.
    """
    unresolved = [s for s in sample_order if timepoint_sort_key(s) == -1.0]
    if unresolved:
        raise ValueError(
            f"{len(unresolved)} sample(s) have no resolvable timepoint in "
            f"JGI_ID_Timepoints_128.csv -- correlation lag_samples would be "
            f"computed against a scrambled time axis: {unresolved[:5]}"
        )

    seen_at: dict[float, str] = {}
    for sample in sample_order:
        key = timepoint_sort_key(sample)
        if key in seen_at:
            raise ValueError(
                f"Samples {seen_at[key]!r} and {sample!r} resolve to the exact "
                f"same timepoint -- their relative order is then arbitrary, "
                f"silently scrambling lag_samples for any pair involving either one."
            )
        seen_at[key] = sample


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
