# Correlation finder: where the time goes and a vectorised replacement

Scope: `GET /correlations/family` (`FastAPI/api/correlation_sql.py::correlation_family_endpoint`), branch `feature/sqlite-integration` @ a993ead. Read-only review; nothing in the repo was changed (`git status` clean). All scripts, the synthetic db and the prototype live in `/tmp/claude-1000/-home-mriffle-dev-sophie-metatrace-HAB/9598effd-5bf0-4fbf-a9d0-bea8f89cfec9/scratchpad/`.

Test rig: synthetic on-disk SQLite db built with the real `SCHEMA` and `INDEXES` (imported from `FastAPI/scripts/create_sql_schema.py` / `create_sql_indexes.py`), WAL mode, 32,000 `annotation_catalog` rows (kegg 13,000, cog 5,000, enzyme 4,000, taxonomy 10,000 of which 7,500 at depth <= 6), 3,137,900 `annotation_series` rows (128 samples `s000..s127`; AR(1) log-normal series, 15-25 % missing for a typical annotation, 10 % sparse annotations with 55-95 % missing, 2 % explicit `egc = 0` rows; rows inserted per sample like `migrate_annotations_to_sql.py`, so one annotation's rows are scattered). 540 MB. Builder: `.../scratchpad/build_bench_db.py`. Everything ran through the real app code by pointing `correlation_sql.SQLITE_DB_PATH` at `bench.db` (`.../scratchpad/bench_common.py`). Machine: i9-14900K, NVMe, db warm in page cache, Python 3.12, numpy 2.5.3, scipy 1.18.1. Timepoints CSV absent locally, so `timepoint_sort_key` returns -1.0 for every sample and `load_sample_order` keeps SQLite's index order (zero-padded names sort chronologically; asserted in the scripts).

**Production I/O is not reproduced here** (no `hab_mappings.db`, WSL2 page-cache eviction unreliable). The comment in `correlation_sql.py` records `load_vector` at ~75 ms live in Sept 2026; locally it is 0.06 ms. Everything below that says "measured" is local CPU + warm cache; I/O-related statements are marked as estimates.

## 1. Where the time goes (measured)

Current code, un-profiled, 400 candidates of a cold kegg family (`.../scratchpad/bench_baseline_time.py`):

| method | ms / candidate | full 13,000-candidate cold family through `correlation_family_endpoint` |
|---|---|---|
| raw_pearson | 4.65 | 54.2 s |
| log_pearson | 4.87 | 54.4 s |
| spearman | 6.30 | 72.9 s and 95.7 s (two runs) |

Warm (every pair cached) family: 0.07 s locally (13,000 point lookups).

Per-candidate cost by component, typical candidate (86 co-observed points), un-profiled micro-timings (`.../scratchpad/bench_components.py`, `bench_commit.py`):

| component (per candidate) | ms | note |
|---|---|---|
| `load_vector` (1 SELECT + 128-iteration Python loop) | 0.06 | 75 ms measured live in Sept 2026 per the code comment; **this is the production I/O term** |
| cache-miss SELECT + 2 `annotation_catalog` lookups | 0.006 | |
| `_transformed_pair` x14 (13 lags + 1 in `_lag_tests_m_eff`): Python filter loop | 0.06 | |
| &nbsp;&nbsp;+ `stats.rankdata` x26 (spearman only) | 0.89 | 34 us per call, almost all scipy dispatch overhead |
| &nbsp;&nbsp;+ `math.log` x28 (log_pearson only) | 0.05 | |
| `stats.pearsonr` x13 | **1.50** | 115 us per call on <=128 points; ~80 % is scipy's array-API wrapper, not arithmetic |
| `_effective_n` x13 (`np.correlate` x26) | 0.13 | |
| `_effective_n_pvalue` (`stats.t.sf`) x13 | 0.25 | 19 us per call |
| `_lag_tests_m_eff` x1 (re-does `_transformed_pair` + both acfs at lag 0, 169 dot products, `eigvalsh`) | 0.51 | `eigvalsh` itself 0.004 |
| `score_pair` total | 3.0 (raw/log) / 4.6 (spearman) | |
| `INSERT` + `conn.commit()` per candidate (WAL, `synchronous=FULL` default = one WAL fsync per candidate) | **0.84** | 13,000 fsyncs per family; slower disks pay more |
| sum | ~4.0 / ~5.5 | matches the 4.65 / 6.30 ms loop figures |

cProfile over 400 spearman candidates (`.../scratchpad/bench_baseline_profile.py`, profiler inflates Python-heavy code ~2x): `score_pair` 76 % (pearsonr 31 %, `_transformed_pair`+rankdata 27 %, `_lag_tests_m_eff` 9 %, `t.sf` 6 %, `_effective_n` 4 %), `commit` 22 %, `load_vector` 2 %.

Bottom line: locally the family is CPU-bound in scipy per-call overhead (13 lags x 4 scipy calls x 13,000 candidates = ~700,000 scipy calls per family), plus one fsync per candidate. On production the per-candidate `load_vector` random reads (~1.7 M rows fetched one annotation at a time) are an additional, probably dominant, term.

Cache-write pattern (2,000 rows, `bench_commit.py`): per-row commit `synchronous=FULL` **0.839 ms/row**; per-row commit `synchronous=NORMAL` 0.018 ms/row; `executemany` + one commit 0.003 ms/row (FULL) / 0.001 (NORMAL).

Loading all candidate vectors (`bench_load.py`, `bench_load_taxonomy.py`, `bench_load_stream.py`): 13,000 `load_vector` calls 0.81 s warm; one `SELECT annotation_id, sample, egc FROM annotation_series WHERE source=?` 1.03 s (0.87 s `fetchall` of 1.28 M tuples + 0.16 s pivot; +250 MB RSS from the tuples) or 1.05 s streaming the cursor into the matrix (+13 MB RSS); `WHERE source=? AND annotation_id IN (<=900 ids)` chunks 0.86 s for 12,935 kegg ids, 0.33 s cog (5,000), 0.54 s enzyme (4,000), 0.58 s taxonomy (7,500 of 10,000). A covering index `(source, annotation_id, sample, egc, norm_egc)` turns the scan into `SEARCH ... USING COVERING INDEX` (0.56 s vs 0.87 s warm; +54 bytes/row, so ~380 MB on the live 7.06 M-row table). Cold-cache numbers were attempted with `posix_fadvise(DONTNEED)` but are not trustworthy on WSL2 and are not reported.

## 2. Proposed design

Keep `score_pair` as the reference implementation (and for the single-pair `/correlation` route); make the family route load once, score all candidates with numpy, and write once.

New/changed functions in `FastAPI/api/correlation_sql.py` (or a new `correlation_vector.py` the route imports):

1. `load_family_matrix(conn, source, metric, annotation_ids, sample_order) -> np.ndarray (m x n_samples)` -- chunks of <= 900 ids with `WHERE source = ? AND annotation_id IN (...)` (uses `idx_annotation_series_source_annotation_id`), iterate the cursor (no `fetchall`), NaN where no row or NULL. Reuse `load_vector` for the reference, converted to a float array with NaN for None. Measured 0.3-0.9 s per family locally.
2. `score_family(ref_vec, matrix, method) -> dict of arrays {ok, r, p, lag, n_pairs, guard}` -- the prototype `.../scratchpad/fast_corr.py::score_family`. Per lag: boolean co-observed mask (`isfinite & > 0`, exactly `_transformed_pair`'s `None or <= 0` rule), count `k`, `k >= 10`; transform (identity / one `np.log` of the whole matrix / row-wise average ranks ignoring NaN, `rank_rows_nan`, exact half-integers); pearson with scipy's own formula (`mean`, `xm/xmax` scaling, `vecdot`, clip, NaN on constant rows); effective N on the gap-compacted demeaned rows (`argsort(~mask, stable)` + `take_along_axis`, autocovariance by 25 `einsum` strided products, weights zero beyond each row's own `k // 5`, `s <= 0 -> k`); `stats.t.sf` once per lag on the whole column; best lag by strict `>` on |r| in `CORRELATION_LAGS` order; `m_eff` from the lag-0 acfs already computed (25 shifted `einsum`s, `(m,13,13)` `np.linalg.eigvalsh`, same floor/clamp arithmetic). Chunk candidates in blocks of ~4,096 rows to cap temporaries (~60 MB instead of 120-190 MB).
3. `score_family_hybrid(...)`: rows flagged by `guard` (|r| within 1e-12 of 1; |r| of two lags within 1e-9; an eigenvalue within 1e-9 of an integer >= 2; `c0` within 1e-9 of 0; `df` within 1e-9 of 1) are recomputed with `score_pair`, so every discontinuous decision is taken by the reference code. Measured trigger rate: 0-5 rows per 13,000 (spearman near-ties), ~5 ms each.
4. `fetch_cached_family(conn, ref_catalog_id, metric, method) -> {other_catalog_id: (r, p, lag_relative_to_ref, n_pairs, at_p_floor)}` -- one query `SELECT catalog_id_a, catalog_id_b, r, lag_samples, p_value, n_pairs, at_p_floor FROM correlations_cache WHERE (catalog_id_a = ? OR catalog_id_b = ?) AND metric = ? AND method = ?`; planner uses `MULTI-INDEX OR` over the UNIQUE index and `idx_correlations_cache_catalog_id_b`; negate `lag_samples` when the ref is `catalog_id_b` (the existing rule). Measured 9.5 ms for 13,000 rows vs 45 ms for 13,000 point lookups (warm).
5. `write_cache_rows(conn, rows)` -- `executemany("INSERT OR IGNORE INTO correlations_cache ...")` + one `commit`, wrapped in the existing `OperationalError` best-effort handling (rollback, still return results). Store canonical `(low, high)` with `lag` negated when the ref is the high id (`score_pair` is symmetric under swapping: r bit-identical, lag negated, p within 8e-15 relative, checked on 2,500 pairs). **Filter non-finite r/p before writing**: sqlite binds NaN as NULL and `OR IGNORE` would then silently drop the row instead of raising. Write a sentinel row for every candidate `score_pair` would return None for (fewer than 10 co-observed, or constant input): `r = 0.0, p = 1.0, lag_samples = 0, n_pairs = 0`; readers drop `n_pairs = 0` rows (`n_pairs >= 10` for every real score, so the sentinel is unambiguous). Without sentinels every warm request would still have uncached candidates and would reload the matrix.
6. `correlation_family_endpoint` flow: validate -> ref id -> `get_family_candidates` -> family lock -> `cached = fetch_cached_family` -> `missing = [c for c in candidates if c["id"] not in cached]` -> if missing: `load_sample_order`, ref vector, `load_family_matrix` for the missing ids, `score_family_hybrid`, `write_cache_rows`, merge -> `_apply_fdr` -> sort -> limit (unchanged). `_get_or_compute_correlation` stays for `/correlation`, but must treat a sentinel row (`n_pairs = 0`) as "not scorable" (return None).
7. `_connect()`: add `PRAGMA synchronous = NORMAL`. In WAL mode this only risks losing the last commits on power loss, never consistency; the cache is recomputable. Worth 0.84 -> 0.02 ms per row even if any per-row commit survives; with batching it is belt and braces.
8. `FastAPI/scripts/create_sql_indexes.py`: add `CREATE INDEX IF NOT EXISTS idx_annotation_series_source_ann_cov ON annotation_series(source, annotation_id, sample, egc, norm_egc)` so the family load is a sequential covering-index scan on production storage (estimate: the live 75 ms-per-annotation random-read cost becomes one ~60 MB sequential index read per source; cost ~380 MB on disk, minutes to build, needs no concurrent writer). Measure `SELECT ... WHERE source='kegg'` live before/after; if the live scan is already fast the index can be skipped.
9. Do audit item N3 (cache versioning) in the same change: a `method_version` in the key or a one-time `invalidate_correlations_cache` at deploy, so no family mixes rows from the scalar and vector paths (they differ in the last digits, see section 4).

Tests to add (`tests/test_correlation_vectorised.py`, in-memory fixture pattern from `tests/test_correlation_tier1_cache.py`):
- `score_family` vs `score_pair` on a seeded 500 x 128 matrix (AR(1) log-normal, missingness, sparse rows, constant rows, copies and +-shifted copies of the ref, tied values): r `atol 1e-12`, p `rtol 1e-9` (and exact on guarded rows), lag and `n_pairs` exact, `None <-> ok=False`, for all three methods.
- `rank_rows_nan` vs `stats.rankdata` on rows with ties and NaN: exact.
- `load_family_matrix` vs `load_vector` element-for-element on the fixture.
- Endpoint: cold request writes one row per candidate (real + sentinel), a second request calls neither `load_family_matrix` nor `score_family` (monkeypatch), lag sign when the ref has the higher id (the untested path noted in audit T2/CR1), sentinel rows never appear in `results`/`tested_count`.
- `INSERT OR IGNORE` race (reuse `RacingConnProxy`): no duplicate rows, winner's row returned; NaN rows filtered before the write.

## 3. Prototype validation and timings

Prototype: `.../scratchpad/fast_corr.py` (`score_family`, `score_family_hybrid`, `rank_rows_nan`). Inputs: ref `(n,)`, candidates `(m, n)`, method; NaN/<= 0 = missing.

Validation A (`.../scratchpad/validate_fast.py`): 2,520 candidates = 2,500 random kegg annotations from `bench.db` (10 % sparse) + 20 constructed edge cases (identical to ref, shifted +2/-3, negated, constant, constant-but-one, exactly 10 co-observed, 9 co-observed, half negative, 6-level ties, noise, periodic, exponential trend, alternating/first-half/top-half missing, zeros for NaN, complement of ref's support, 12-point linear/quadratic). Per method: 3 `None` results, all reproduced; max |delta r| 5.6e-16; max |delta p| 4.2e-15; lag and n_pairs exact; **0 mismatches** at r atol 1e-12 / p rtol 1e-9. Guarded rows 11 / 8 / 12 (the |r| ~ 1 edge cases plus a few near-ties); after the scalar fallback the p-values of those rows are exactly equal too.

Validation B (`.../scratchpad/validate_full_cache.py`): ran the **real endpoint** cold for each method (13,000 rows written by the current code, with its own low/high orientation and lag negation), then compared every cached row with the vectorised output: **0 mismatches** for raw_pearson, log_pearson and spearman; max |delta r| 5.6e-16; max relative |delta p| 3.5e-14; top-500 after FDR in identical order; `significant_count` identical (534 / 0 / 0). Guarded rows 0 / 0 / 5.

Discrepancy found and its cause (`.../scratchpad/validate_detail.py`): candidates perfectly correlated with the ref. The scalar path lands on r = 1.0 exactly and short-circuits `r*r >= 1` to p = 0.0 while the vector path gets 0.9999999999999998 and p ~ 8e-308 (and the reverse for log_pearson: scalar 0.9999999999999997 / p = 5.4e-178, vector 1.0 / p = 0). Harmless numerically, but the stored `p_value` would differ, hence the `|r| > 1 - 1e-12` guard. Identical series across sources (a KO and its single EC mapping the same genes) make this a real-data case.

Timings (local, warm cache):

| family (cold) | current endpoint | proposed path | of which load / score / write |
|---|---|---|---|
| kegg 13,000, raw_pearson | 54.2 s | **2.3 s** | 1.05 / 1.2 / 0.03 s |
| kegg 13,000, log_pearson | 54.4 s | **2.7 s** | 1.05 / 1.2 / 0.37 s (one commit outlier; 0.03 s otherwise) |
| kegg 13,000, spearman | 72.9-95.7 s | **4.0 s** | 1.08 / 2.9 / 0.03 s |
| kegg->kegg 12,935 (same-source exclusions), spearman | ~81 s (extrapolated) | 3.7 s | 0.86 / 2.84 |
| cog 5,000, spearman | ~32 s (extrapolated) | 1.4 s | 0.33 / 1.04 |
| enzyme 4,000, spearman | ~25 s (extrapolated) | 1.4 s | 0.54 / 0.83 |
| taxonomy 7,500 (depth <= 6), spearman | ~47 s (extrapolated) | 2.2 s | 0.62 / 1.60 |

(`.../scratchpad/bench_fast_family.py`, `bench_fast_sources.py`.) Scoring alone: 0.107 ms/candidate (pearson) and 0.261 ms/candidate (spearman) vs 3.0 / 4.6 ms, i.e. 28x / 18x; end-to-end 18-24x. Inside `score_family` for spearman (3.4 s, `profile_fast.py`): `argsort` for ranking 1.0 s, masked pearson 0.7 s, rank bookkeeping 0.5 s, compaction 0.34 s, autocovariance 0.19 s, m_eff 0.07 s, `t.sf` 0.02 s. The ranking argsort could be halved by ranking the ref once per lag (its mask differs per candidate, so this needs a different formulation; not done).

Warm path: one OR query 9.5 ms vs 13,000 point lookups 45 ms (local); the current warm endpoint total is 0.07 s, so the warm gain is small locally and matters only on cold production pages (2 index range scans instead of 13,000 probes).

Option (d), measured (`.../scratchpad/lean_scalar.py`): keeping the per-candidate loop but replacing the Python filter with masks, `pearsonr` with the direct formula, batching `t.sf` once per candidate and reusing lag-0 acfs gives 0.77 ms (pearson) / 1.89 ms (spearman) per candidate = 10 s / 25 s per 13,000 family (0 mismatches on 500), i.e. 4-6x over today but 5-8x slower than the vectorised path. With (a)+(b) added it lands around 11-26 s per family. Not recommended when the vector version is 150 lines and validated.

Memory (`.../scratchpad/bench_memory.py`): dense kegg matrix 13.3 MB; `score_family` peak temporaries 118 MB (pearson) / 187 MB (spearman) for 13,000 rows -> chunk at ~4,096 rows; `fetchall` of 1.28 M row tuples +250 MB RSS -> stream the cursor (+13 MB).

## 4. Risks and what changes numerically

- Not bit-for-bit. Reductions run row-wise on zero-padded arrays (numpy pairwise summation with different blocking) where scipy/numpy used BLAS `ddot` (`np.correlate`, `@`) or pairwise sums over the compacted length. Measured: r within 6e-16, p within 5e-15 absolute / 4e-14 relative, lag and n_pairs exact, on 2,520 + 39,000 pairs. `np.log` and `math.log` agreed bit-for-bit on 2 M values on this build (glibc vs numpy SIMD); on another build they may differ by 1 ulp, still within tolerance.
- Discontinuous decisions (best-lag tie, `r*r >= 1`, `m_eff`'s `floor` at integer eigenvalues >= 2, `c0 <= 0`, `df < 1`) are delegated to `score_pair` when within 1e-9..1e-12 of the boundary. Outside those bands the vector decisions are provably the same comparisons on values that differ by ~1e-15. Trigger rate 0-5 per 13,000 on synthetic data; real data with duplicated series will trigger the |r| ~ 1 guard more, at ~5 ms per row.
- `score_pair` must remain the reference; any future change to it has to be mirrored in `score_family`, enforced by the equality test above.
- Old cached rows (scalar) and new rows (vector) differ in the last digits; ranking is unaffected (validation B: identical order), but version/clear the cache (N3) so one family is never half-and-half.
- Sentinel rows change `correlations_cache` semantics (`n_pairs = 0`); every reader (`/correlation`, any script) must filter them.
- Covering index: +~380 MB live, minutes to build, must run with no concurrent writer; its benefit is an I/O estimate, not a local measurement.
- `INSERT OR IGNORE` also hides NOT NULL violations; the explicit non-finite filter is load-bearing.

## 5. Secondary findings

1. Unscorable candidates (fewer than 10 co-observed points, or constant on the co-observed points -> `pearsonr` NaN) return None and are never cached, so they are recomputed on every request (3 of 2,520 random synthetic candidates; real taxonomy/sparse KOs will be many more). In the batched design this would force a matrix load on every "warm" request; the sentinel row fixes it.
2. The per-family lock stays useful (a retry or second tab waits 2-5 s instead of recomputing), and `INSERT OR IGNORE` makes concurrent writers safe even across worker processes where the lock does not reach. The lock is held during load + score; fine at seconds, was painful at minutes.
3. The sync route occupies a Starlette thread-pool thread (default 40) for the whole request; today a 1-16 minute request plus up to 12 client retries can tie up several. At ~5 s cold this is moot; numpy also releases the GIL during the large ops. Keep the client retry as a safety net; the 60 s nginx cut-off (audit N1) should no longer be reached for any source (taxonomy 7,500: 2.2 s locally; allow 3x on a slow host).
4. Caching dense matrices in-process would cost 13.3 MB per (kegg, metric), ~56 MB for all 8 (source, metric) pairs at the taxonomy cutoff; the per-request load is 0.3-1 s, so I would not cache initially. If added, key on (source, metric, db mtime) so migrations invalidate it.
5. `busy_timeout = 10000` vs the 60 s proxy: the cache writes themselves cannot approach 10 s once batched (one ~30 ms transaction instead of 13,000 write-lock acquisitions). The bad interaction today is different: the proxy drops the connection at 60 s, the client retries, each retry parks a thread on the family lock, and the original keeps fsyncing per candidate. Keep the `OperationalError` best-effort path around the batched write (a long migration/VACUUM holding the lock should still return results, uncached).
6. scipy per-call overhead is the real scalar cost: `pearsonr` 115 us, `rankdata` 34 us, `t.sf` 19 us per call on <=128 points, ~700,000 calls per family. `_lag_tests_m_eff` repeats the lag-0 `_transformed_pair` and both acfs that `core_scoring` already computed.
7. `score_pair` is symmetric under swapping ref/cand (r bit-identical, lag negated, p within 8e-15) because the Bartlett cross-term is even in the shift, so the endpoint can compute everything ref-oriented and only flip the sign when storing; the current per-pair `(low, high)` reload and reorientation is unnecessary work.
8. `PRAGMA synchronous` is per connection and is FULL by default on these connections: every per-candidate commit is a WAL fsync (0.84 ms locally, 13,000 per family).
9. Synthetic-data caveats: `annotation_series.depth` is NULL in the bench db (so a `depth <= 6` series filter was not benchmarked; the IN-chunk load on catalog-derived ids avoids needing it), `norm_egc` was not scored (same code path, different column), and production disk behaviour is estimated only.

Files: `build_bench_db.py` (rig), `bench_common.py`, `bench_baseline_profile.py`, `bench_baseline_time.py`, `bench_components.py`, `bench_commit.py`, `bench_load.py`, `bench_load_stream.py`, `bench_load_taxonomy.py`, `bench_fast_family.py`, `bench_fast_sources.py`, `bench_memory.py`, `profile_fast.py`, `fast_corr.py` (prototype), `lean_scalar.py` (option d), `validate_fast.py`, `validate_detail.py`, `validate_full_cache.py`, all under `/tmp/claude-1000/-home-mriffle-dev-sophie-metatrace-HAB/9598effd-5bf0-4fbf-a9d0-bea8f89cfec9/scratchpad/`; `bench.db` (540 MB) is the synthetic database.
