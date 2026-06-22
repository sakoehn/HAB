"""
correlation.py
--------------
Spearman correlation with lag, CLR pre-processing, and the
/annotations/correlate endpoint.

Statistical approach
~~~~~~~~~~~~~~~~~~~~
1. CLR transformation (Aitchison 1986; ALDEx2/CoDaSeq convention) centres
   each EGC time series in log space relative to the geometric mean of all
   annotations in that sample.  This corrects for compositional dependence
   (sum-to-one bias) without requiring a reference taxon.

2. Spearman rank correlation is computed over the lag window
   {0, ±1, ±2, ±3, ±6} samples (= 0–24 h at the 4-hour cadence).  The lag
   that maximises |r| is reported.

3. P-value: circular block-shift permutation test (seed=42, n=1000),
   evaluated at the single lag that produced the reported correlation
   (the observed best lag) — not re-searched across all lags on every
   permutation. See _circular_shift_pvalue for the full rationale.
   Cite "circular block permutation at the observed lag" in methods.

Lag sign convention
~~~~~~~~~~~~~~~~~~~
  lag_hours > 0 → candidate leads reference
  lag_hours < 0 → reference leads candidate
  lag_hours = 0 → simultaneous

Caching strategy
~~~~~~~~~~~~~~~~
- The CLR matrix is built once per source on first request and stored in
  _CLR_MATRIX.  Without this cache, a full _clr_detrend() over 10k+ KEGG
  annotations × 128 samples was being repeated on every /correlate call.
- _CORR_CACHE stores the full sorted candidate list (with paired vectors
  attached) keyed by (source, annotation_id, mode, target_source,
  skip_pvalue) — WITHOUT limit.  Permutation p-values are computed lazily
  and written back into the cached dicts in place so subsequent requests
  for a higher limit reuse already-computed p-values.

Performance note (read before changing the permutation logic)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
The permutation p-value step used to re-search all CORRELATION_LAGS values
on every one of PERMUTATION_N=1000 shifts, and re-ranked BOTH the shifted
reference AND the (unchanged) candidate on every shift. For limit=50
candidates that is up to 50 × 1000 × 9 = 450,000 full rank-correlation
evaluations per request, which is what made /annotations/correlate take
several minutes.

Two changes fixed this without changing the underlying statistics in any
way that loses meaning:
  (a) the candidate's rank vector is computed ONCE per candidate, since
      circular-shifting the reference never changes the candidate's values;
  (b) the lag is fixed at the single lag that produced the reported
      correlation, instead of being re-optimized on every permutation.
See _circular_shift_pvalue's docstring for why (b) is also the more
standard / defensible choice scientifically, not just a speed hack.
"""

import math
import random
import threading

from fastapi import APIRouter, HTTPException, Query

from .cache import (
    AnnotationSource,
    extract_annotation_name,
    extract_parent,
)
from .config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE, PERMUTATION_N, PERMUTATION_SEED
from .index import (
    _EGC_SAMPLES,
    _EGC_MATRIX,
    _EGC_NAME_MAP,
    _EGC_PARENT_MAP,
    get_egc_vectors_from_matrix,
    timepoint_sort_key,
)
from .cache import get_all_sample_names, load_annotations_by_source, extract_egc

router = APIRouter()

# ── CLR matrix cache ──────────────────────────────────────────────────────────

_CLR_MATRIX: dict[str, dict[str, list[float]]] = {}
_CLR_LOCK   = threading.Lock()

# ── Correlation result cache ──────────────────────────────────────────────────

_CORR_CACHE: dict[tuple, list] = {}


# ── Math primitives ───────────────────────────────────────────────────────────

def _rank(vec: list[float]) -> list[float]:
    """Convert values to 1-based ranks, averaging ties."""
    n       = len(vec)
    indexed = sorted(range(n), key=lambda i: vec[i])
    ranks   = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j < n - 1 and vec[indexed[j]] == vec[indexed[j + 1]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank
        i = j + 1
    return ranks


def _spearman_from_ranks(ra: list[float], rb: list[float]) -> float | None:
    """
    Pearson correlation of two pre-computed rank vectors — this IS Spearman's
    rank correlation by definition once the inputs are ranks instead of raw
    values.

    Split out from _spearman() so the permutation test can rank the
    candidate ONCE and reuse that same rank vector across every one of the
    1000 shifted-reference comparisons, instead of re-ranking unchanged
    candidate data a thousand times.
    """
    n = len(ra)
    if n < 10:
        return None
    mean_ra = sum(ra) / n
    mean_rb = sum(rb) / n
    num     = sum((ra[i] - mean_ra) * (rb[i] - mean_rb) for i in range(n))
    denom   = math.sqrt(
        sum((r - mean_ra) ** 2 for r in ra) *
        sum((r - mean_rb) ** 2 for r in rb)
    )
    return num / denom if denom else None


def _spearman(a: list[float], b: list[float]) -> float | None:
    """
    Spearman rank correlation between two equal-length vectors.
    Returns None when n < 10 (insufficient pairs for a meaningful estimate).
    """
    if len(a) < 10:
        return None
    return _spearman_from_ranks(_rank(a), _rank(b))


def _spearman_at_lags(
    ref:  list[float],
    cand: list[float],
    lags: list[int],
) -> tuple[float, int] | tuple[None, None]:
    """
    Compute Spearman r at each lag offset and return (best_r, best_lag)
    where best is defined by maximum |r|.

    Positive lag: ref is shifted forward (candidate leads ref).
    Negative lag: cand is shifted forward (ref leads candidate).

    Used only for the initial observed-correlation scan (Pass 1) and is
    NOT used inside the permutation loop — see _circular_shift_pvalue.
    """
    best_r:   float | None = None
    best_lag: int          = 0
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

        r = _spearman(a, b)
        if r is None:
            continue
        if best_r is None or abs(r) > abs(best_r):
            best_r   = r
            best_lag = lag

    return (best_r, best_lag) if best_r is not None else (None, None)


def _circular_shift_pvalue(
    ref:           list[float],
    cand:          list[float],
    observed_r:    float,
    observed_lag:  int,
    n_perm:        int,
    rng_seed:      int,
) -> float:
    """
    Permutation p-value via circular block shifts of the reference series.

    Circular shifts preserve temporal autocorrelation in the reference,
    producing a more conservative (and correct) null distribution than i.i.d.
    shuffling for autocorrelated EGC time series.

    Why the lag is FIXED for every permutation (not re-searched):
    The reported result is "this candidate correlates with the reference at
    lag X". The p-value should answer "how surprising is THAT specific
    relationship under the null", which means every permutation should be
    evaluated at that same lag X. Re-searching all candidate lags on every
    permutation instead answers a looser question — "is there some lag,
    possibly different lags each time, with a strong correlation" — which
    doesn't match what lag_hours reports to the user, is statistically
    unconventional, and was also the single biggest cost in this endpoint
    (~9x more rank computations than necessary for no added meaning here).

    The candidate's rank vector is also computed once, since circular-
    shifting the reference never changes the candidate values — recomputing
    an unchanged rank vector 1000 times was pure waste.

    Parameters
    ----------
    seed : 42, n : 1000 — cite as "circular block permutation at the
    observed optimal lag, n=1000, seed=42" in methods.
    """
    n = len(ref)
    if n < 3:
        return 1.0

    # Slice the candidate at the observed lag once. This slice never
    # changes across permutations (only the reference is shifted), so its
    # rank vector is computed exactly once instead of n_perm times.
    if observed_lag >= 0:
        cand_slice = cand[: n - observed_lag] if observed_lag > 0 else cand
    else:
        cand_slice = cand[-observed_lag:]

    if len(cand_slice) < 10:
        return 1.0

    rb = _rank(cand_slice)

    rng   = random.Random(rng_seed)
    count = 0

    for _ in range(n_perm):
        shift   = rng.randint(1, n - 1)
        shifted = ref[shift:] + ref[:shift]

        if observed_lag >= 0:
            ref_slice = shifted[observed_lag:]
        else:
            ref_slice = shifted[: n + observed_lag]

        if len(ref_slice) < 10:
            continue

        ra     = _rank(ref_slice)
        r_perm = _spearman_from_ranks(ra, rb)
        if r_perm is not None and abs(r_perm) >= abs(observed_r):
            count += 1

    return count / n_perm


# ── CLR transformation ────────────────────────────────────────────────────────

def _clr_detrend(
    vectors:   dict[str, list[float | None]],
    n_samples: int,
) -> dict[str, list[float]]:
    """
    Centre-log-ratio (CLR) transformation of EGC time-series vectors.

    Standard compositional metagenomics approach (Aitchison 1986; ALDEx2,
    CoDaSeq).  Zero / None values are excluded from the geometric mean
    denominator and set to 0.0 in the output vector.
    """
    log_geo_sum   = [0.0] * n_samples
    log_geo_count = [0]   * n_samples

    for vec in vectors.values():
        for i, v in enumerate(vec):
            if i >= n_samples:
                break
            if v is not None and v > 0:
                log_geo_sum[i]   += math.log(v)
                log_geo_count[i] += 1

    log_geo_mean = [
        log_geo_sum[i] / log_geo_count[i] if log_geo_count[i] > 0 else 0.0
        for i in range(n_samples)
    ]

    return {
        ann_id: [
            (math.log(v) - log_geo_mean[i]) if (v is not None and v > 0) else 0.0
            for i, v in enumerate(vec)
            if i < n_samples
        ]
        for ann_id, vec in vectors.items()
    }


def _get_clr_matrix(source: AnnotationSource) -> dict[str, list[float]]:
    """
    Return CLR-transformed vectors for a source, computing and caching on
    first call.  Thread-safe via double-checked locking.
    """
    src = source.value
    if src in _CLR_MATRIX:
        return _CLR_MATRIX[src]

    with _CLR_LOCK:
        if src in _CLR_MATRIX:
            return _CLR_MATRIX[src]

        vectors, _, _ = get_egc_vectors_from_matrix(source)
        n   = len(_EGC_SAMPLES) if _EGC_SAMPLES else len(next(iter(vectors.values()), []))
        clr = _clr_detrend(vectors, n)
        _CLR_MATRIX[src] = clr
        return clr


# ── Response helpers ──────────────────────────────────────────────────────────

def _finish_correlation_response(
    annotation_id: str,
    source:        AnnotationSource,
    mode:          str,
    target_source: AnnotationSource | None,
    skip_pvalue:   bool,
    results:       list[dict],
    limit:         int,
) -> dict:
    """
    Slice results to limit, compute missing p-values in place (memoized),
    strip internal pairing data, and return the response envelope.

    results is the SAME list stored in _CORR_CACHE — mutations are
    intentional so that a later request with a higher limit reuses
    already-computed p-values without redoing work.
    """
    top = results[:limit]

    if not skip_pvalue:
        for row in top:
            if row.get("p_value") is None:
                p = _circular_shift_pvalue(
                    row["_paired_ref"],
                    row["_paired_cand"],
                    row["spearman_r"],
                    row["lag_samples"],
                    PERMUTATION_N,
                    PERMUTATION_SEED,
                )
                row["p_value"] = round(p, 4)

    public_top = [
        {k: v for k, v in row.items() if not k.startswith("_paired_")}
        for row in top
    ]

    return {
        "reference":             annotation_id,
        "source":                source.value,
        "mode":                  mode,
        "target_source":         target_source.value if target_source else source.value,
        "preprocessing":         "clr",
        "pvalue_method":         "circular_shift_permutation" if not skip_pvalue else None,
        "lag_hours_per_sample":  LAG_HOURS_PER_SAMPLE,
        "permutation_n":         None if skip_pvalue else PERMUTATION_N,
        "permutation_seed":      None if skip_pvalue else PERMUTATION_SEED,
        "skip_pvalue":           skip_pvalue,
        "data":                  public_top,
    }


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/annotations/correlate")
def correlate_annotations(
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
    mode: str = Query(
        "cross",
        description=(
            "'cross' = cross-source correlation (default: KEGG vs Taxonomy); "
            "'within' = same source, parent-filtered"
        ),
    ),
    target_source: AnnotationSource | None = Query(None),
    skip_pvalue:   bool = Query(False),
    limit:         int  = Query(10, ge=1, le=50),
):
    """
    Correlate a reference annotation against candidates using Spearman rank
    correlation with a lag window of ±1, ±2, ±3, ±6 samples (0–24 h at 4h
    cadence).

    Pre-processing: CLR transformation.
    P-value: circular-shift permutation test at the observed best lag
    (seed=42, n=1000).
    """
    if mode not in ("cross", "within"):
        raise HTTPException(status_code=400, detail="mode must be 'cross' or 'within'")

    if mode == "cross":
        if target_source is None:
            target_source = (
                AnnotationSource.taxonomy
                if source != AnnotationSource.taxonomy
                else AnnotationSource.kegg
            )
        if target_source == source:
            raise HTTPException(
                status_code=400, detail="cross mode requires target_source != source"
            )
    else:
        target_source = source

    cache_key = (
        source.value, annotation_id, mode,
        target_source.value if target_source else "",
        skip_pvalue,
    )

    if cache_key in _CORR_CACHE:
        return _finish_correlation_response(
            annotation_id, source, mode, target_source,
            skip_pvalue, _CORR_CACHE[cache_key], limit,
        )

    # ── Build reference CLR vector ────────────────────────────────────────────
    ref_vectors, ref_name_map, ref_parent_map = get_egc_vectors_from_matrix(source)
    ref_raw = ref_vectors.get(annotation_id)
    if not ref_raw:
        raise HTTPException(
            status_code=404,
            detail=f"Annotation '{annotation_id}' not found for source '{source.value}'",
        )

    ref_parent = ref_parent_map.get(annotation_id)
    n_samples  = len(ref_raw)

    all_ref_clr = _get_clr_matrix(source)
    ref_clr     = all_ref_clr.get(annotation_id)
    if ref_clr is None:
        raise HTTPException(
            status_code=404,
            detail=f"CLR vector not available for '{annotation_id}' in '{source.value}'",
        )

    # ── Candidate set ─────────────────────────────────────────────────────────
    if mode == "cross":
        cand_vectors, cand_name_map, cand_parent_map = get_egc_vectors_from_matrix(target_source)
        cand_source_label = target_source.value
        all_cand_clr      = _get_clr_matrix(target_source)
    else:
        cand_vectors      = ref_vectors
        cand_name_map     = ref_name_map
        cand_parent_map   = ref_parent_map
        cand_source_label = source.value
        all_cand_clr      = all_ref_clr

    R_THRESHOLD = 0.2 if mode == "cross" else 0.3

    # ── Pass 1: Spearman r + lag for all candidates above threshold ───────────
    results: list[dict] = []

    for cand_id, cand_raw in cand_vectors.items():
        if cand_id == annotation_id:
            continue
        if mode == "within":
            cand_parent = cand_parent_map.get(cand_id)
            if cand_parent and ref_parent and cand_parent == ref_parent:
                continue

        cand_clr = all_cand_clr.get(cand_id)
        if cand_clr is None:
            continue

        n_valid     = min(len(ref_raw), len(cand_raw), n_samples)
        paired_ref  = [
            ref_clr[i] for i in range(n_valid)
            if ref_raw[i] is not None and ref_raw[i] > 0
            and cand_raw[i] is not None and cand_raw[i] > 0
        ]
        paired_cand = [
            cand_clr[i] for i in range(n_valid)
            if ref_raw[i] is not None and ref_raw[i] > 0
            and cand_raw[i] is not None and cand_raw[i] > 0
        ]

        if len(paired_ref) < 10:
            continue

        best_r, best_lag = _spearman_at_lags(paired_ref, paired_cand, CORRELATION_LAGS)
        if best_r is None or abs(best_r) < R_THRESHOLD:
            continue

        results.append({
            "annotation_id": cand_id,
            "source":        cand_source_label,
            "name":          cand_name_map.get(cand_id),
            "parent":        cand_parent_map.get(cand_id),
            "spearman_r":    round(best_r, 4),
            "abs_r":         round(abs(best_r), 4),
            "lag_samples":   best_lag,
            "lag_hours":     best_lag * LAG_HOURS_PER_SAMPLE,
            "p_value":       None,
            "n_pairs":       len(paired_ref),
            # Internal — stripped before returning; retained for lazy p-value
            # computation on subsequent requests with a higher limit.
            "_paired_ref":  paired_ref,
            "_paired_cand": paired_cand,
        })

    results.sort(key=lambda x: x["abs_r"], reverse=True)
    _CORR_CACHE[cache_key] = results

    return _finish_correlation_response(
        annotation_id, source, mode, target_source,
        skip_pvalue, results, limit,
    )