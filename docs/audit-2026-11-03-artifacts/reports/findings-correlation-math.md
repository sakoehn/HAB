# Correlation finder: statistical and logical correctness review

Repo `/home/mriffle/dev/sophie-metatrace/HAB`, branch `feature/sqlite-integration`, HEAD `a993ead`. Read-only review; scripts and raw outputs are in `/tmp/claude-1000/-home-mriffle-dev-sophie-metatrace-HAB/9598effd-5bf0-4fbf-a9d0-bea8f89cfec9/scratchpad/` (`sim_null.py` / `sim_null.json`, `sim_fdr.py` / `sim_fdr_partial.jsonl`, `sim_followup.py`, `sim_small_n.py`, `meff_small_n.py`, `check_family.py`, `check_lag.py`, `gap_arith.py`).

Test suite: `pytest tests/ -m "not api and not slow"` on the eight correlation test files: 129 passed; `-m slow` (test_correlation_math.py): 7 passed in 47 s.

Summary: the method does what the Methods page says. The lag sign is right end to end, the Pyper & Peterman and Li & Ji pieces are implemented as described, the family exclusions match their documentation in every fixture I could construct, and Benjamini-Hochberg over the family holds the realized FDR (0 false discoveries in 130 discoveries over 24 simulated families; 0 in 10 pure-null families of 2,000). The findings below are about what the user is shown for the lag, a per-pair rate that runs 5.8-7.3% instead of 5% with an identified cause and two-line fix, and a few wording mismatches.

---

### [M] "leads/lags by N h" is a nominal conversion; across the 8-12 h gaps the true offset is up to 12-16 h larger

**Where:** `FastAPI/api/correlation_sql.py:728` (`lag_hours = lag_samples * LAG_HOURS_PER_SAMPLE`); `frontend/src/components/correlates/CorrelatesPanel.tsx:182-187, 406-409`; `frontend/src/pages/MethodsPage.tsx:262-266` ("0-24 h at 4 h per sample", "up to a full day of lead or lag"). The approximation is acknowledged only in a backend docstring (`correlation_loaders.py:51-57`).

**What is wrong:** lags are sample-index shifts over `sample_order`; the hours shown multiply by 4 regardless of the gaps. The real timepoints CSV is absent from this checkout and no fixture or doc records the gap positions, so I computed the error under plausible placements (128 samples over 27 May-18 June, ~133 four-hour slots, 5 missing slots; `gap_arith.py`):

| chosen lag (shown) | share of contributing pairs whose true offset differs | offsets actually spanned |
|---|---|---|
| 1 (4 h) | 2-4% | 4, 8, 12 h |
| 3 (12 h) | 6-12% | 12-20 h (28 h if two gaps are adjacent) |
| 6 (24 h) | 12-25% | 24-32 h (up to 40 h) |

So "leads by 24h" is exact for only ~75-88% of the point-pairs that produced that r, and the extreme pair spans 32-40 h. The r itself is also computed with those misaligned pairs mixed in (inherent to index lags; magnitude small).

**User-visible effect:** a candidate labelled "lags by 12h" may actually lag by 12-20 h for part of the series; the Methods page's "up to a full day" understates the window.

**How verified:** read; arithmetic under four gap placements (confirmed arithmetic, placements unverified against the real CSV).

**Suggested fix:** state on the Methods page and in the panel tooltip that lag hours are nominal (4 h per sample; 8-12 h across the gaps), or compute the lag on the real time axis (shift by hours and pair by nearest timestamp, which also removes the misaligned pairs).

---

### [M] Under the null, 37% of candidates are labelled with the window-edge lag (+/-24 h); the non-significant tail of the list is dominated by that label

**Where:** `correlation_sql.py:192-218` (`_spearman_at_lags` keeps max |r| over 13 lags); `CorrelatesPanel.tsx:360-410` shows `fmtLag(row.lag_hours)` for every row, significant or not; sort at `correlation_sql.py:745` puts the non-significant rows in |r| order.

**What is wrong:** for smooth series the cross-correlation across neighbouring lags is itself a smooth random function, and the maximum of a smooth function over a bounded window sits at an endpoint far more often than anywhere else. Simulation (independent AR(1), phi 0.85, n 128, Spearman, 8,000 null pairs): |lag| = 6 is chosen 37.1% of the time, |lag| = 1..5 about 11% each, lag 0 only 5.4%. Among the top 5% of null pairs by |r| (what the panel's non-significant tail shows), 32% carry "leads/lags by 24h" and 6% "no lag". True relationships are not affected: a true lag-0 pair with r ~ 0.68 is reported at lag 0 in 1000/1000 runs, and a true lead of 3 samples is recovered 999/1000 (969/1000 with 20% missing).

**User-visible effect:** a weak, non-significant row reads "+0.54, lags by 24h, q=0.6, n=128" as confidently as a significant one; the 24 h is an artefact of the search window, not a property of the pair.

**How verified:** simulation (`sim_followup.py`, confirmed); FDR-level consequence is nil (the p-value at the edge lags is not inflated: rate 4.7% at |lag| = 6 vs 6-8% elsewhere).

**Suggested fix:** show the lag only for significant rows (or grey it out otherwise), and/or mark lags at the window edge as "at search limit (>= 24 h)". Mention on the Methods page that for unrelated pairs the chosen lag tends to the edge of the window.

---

### [M] Per-pair false-positive rate is 5.8% with full data and up to 7.3% with structured missingness; the cause is the uncorrected autocorrelation estimator (new quantitative detail on CR2)

**Where:** `correlation_sql.py:100-104` (`_autocorrelations`: standard biased estimator, denominator `full[0]` over all N terms) feeding `_effective_n` at 127, which then applies the `(N-j)/N` weight.

**What is wrong:** the `(N-j)/N` weight in the Pyper & Peterman formula belongs with autocorrelations estimated by the bias-corrected `N/(N-j)` form (the estimator they pair with it); applying it on top of the already-shrunk biased estimator discounts long-lag autocorrelation twice, so N_eff is a little too large and p a little too small. Replacing `_autocorrelations(...)` by `_autocorrelations(...) * n/(n-j)` inside `_effective_n` (two lines) moves the lag-0 rate to 5.1-5.6% in every condition tested (table below). Structured missingness (candidate detected only in a contiguous 80-sample window) is where the current estimator is worst: 6.4% at lag 0, 7.3% after the lag search.

**User-visible effect:** none at the significant/not-significant boundary in practice: BH across the family absorbs it (0 false discoveries in 130, below). It mainly affects the raw `p` of the single-pair endpoint and the ordering of borderline q-values.

**How verified:** simulation, 3,000-6,000 pairs per condition (`sim_null.py`, confirmed).

**Suggested fix:** use the `N/(N-j)`-corrected estimator in `_effective_n` (and for consistency in `_lag_tests_m_eff`), re-run `TestEffectiveNFalsePositiveRateSimulation` and tighten its bar to 6%, and update the Methods paragraph; or state the measured rate.

---

### [L] "Every candidate in the family is tested" is not quite what happens, and `tested_count` is the scored count

**Where:** `MethodsPage.tsx:281-282`; `correlation_sql.py:718-719, 752`.

**What is wrong:** candidates with fewer than 10 co-observed timepoints, or constant across them, return `None` from `score_pair` and are dropped before `_apply_fdr`; `tested_count` is `len(scored)`. BH over the scored set is the right family (the dropped ones have no p-value), but the page says every candidate is tested and the panel's "N of M" never says some were untestable. (Perf note: a `None` result is never cached, so those pairs are recomputed on every request.)

**How verified:** read; `test_returns_none_and_inserts_nothing_when_too_few_valid_pairs` pins the behaviour.

**Suggested fix:** return an `untested_count` (or say "M scored; K had fewer than 10 shared timepoints") and soften the Methods sentence.

---

### [L] "about half of unrelated but smooth pairs pass" the naive test depends on which naive test

**Where:** `MethodsPage.tsx:231-234`.

**What is wrong:** for independent AR(1) pairs at phi 0.85 the naive t-test passes 39-41% at lag 0 and 79-80% at the best of 13 lags (all three coefficients). "About half" is between the two.

**How verified:** simulation (`sim_null.py`).

**Suggested fix:** "about 40% at a single lag, about 80% after searching the lags".

---

### [L] Single-pair `/correlation` with an unknown catalog id returns 500, not 404

**Where:** `correlation_sql.py:564-571`: `row_low[0]` with `row_low is None` raises `TypeError`.

**User-visible effect:** API only; the frontend never calls `/correlation` (`AboutPage.tsx:145` only documents it). The About page's description of its p ("effective-sample-size p-value, Bonferroni-corrected for the number of separate tests the lag search is worth") is correct and makes no FDR claim.

**How verified:** read; no endpoint test covers it.

---

### [L] Hygiene

- `CorrelatesPanel.tsx:5-6` header comment: "Every scored candidate comes back ranked by |r|" predates the significant-first sort.
- No frontend test asserts the "leads by" / "lags by" text for a non-zero `lag_hours` (`correlates-panel.component.test.tsx` only uses lag 0); the sign convention is pinned only by the backend tests. Given AUDIT CR1's history this is the one display mapping worth a test.
- `_lag_tests_m_eff` (`correlation_sql.py:165-167`) measures the penalty on the lag-0 overlap; if that overlap has < 10 points but the chosen lag had >= 10, the pair is charged the full 13 (conservative, rare).
- `test_correlation_tier1_cache.py:218` is still misnamed (AUDIT T2/CR1); I ran the untested path and it is correct (see below).

---

## Simulation results

Independent AR(1) series, phi = 0.85 unless stated, n = 128, offset +30 so no value is dropped as <= 0; "app" = `score_pair` exactly as deployed (best |r| over 13 lags, effective-N p at that lag, Bonferroni by Li & Ji m_eff). Rates are the share of pairs with p <= 0.05. 3,000-6,000 pairs per row; standard error about 0.3-0.4 points.

| condition (Spearman unless noted) | app | lag-0 eff-N | lag-0 eff-N, N/(N-j) ACF | best lag, uncorrected | best lag x13 | naive lag 0 | naive best lag | N_eff median | m_eff mean |
|---|---|---|---|---|---|---|---|---|---|
| full data | **5.8%** | 5.7% | 5.1% | 20.4% | 1.7% | 38.6% | 78.9% | 30.0 | 3.91 |
| full, raw Pearson | 5.8% | 5.9% | 5.3% | 20.2% | 1.5% | 40.3% | 80.3% | 28.6 | 3.85 |
| full, log-Pearson | 5.7% | 5.9% | 5.2% | 20.2% | 1.5% | 40.7% | 80.2% | 28.6 | 3.85 |
| 20% missing at random, each series | **6.2%** | 6.1% | 5.6% | 25.3% | 1.9% | 30.1% | 74.5% | 28.2 | 4.87 |
| candidate detected only in an 80-sample window | **7.3%** | 6.4% | 5.4% | 25.2% | 1.8% | 37.7% | 79.3% | 21.7 | 4.20 |
| window + 20% missing | 6.9% | 7.1% | 5.9% | 31.1% | 2.7% | 30.4% | 76.2% | 20.3 | 5.37 |
| phi = 0.95 | 6.2% | 6.6% | 5.5% | 17.4% | 0.8% | 60.9% | 86.5% | 16.1 | 2.93 |
| phi = 0.50 | 5.3% | 5.1% | 5.0% | 36.3% | 3.0% | 11.9% | 62.7% | 84.5 | 7.98 |
| white noise | 3.5% | 4.5% | 4.5% | 45.4% | 3.3% | 4.8% | 47.4% | 128 | 12.65 |
| shared linear trend (by design "real") | 39.8% | 50.5% | 29.1% | 72.9% | 2.4% | 99.7% | 99.8% | 9.8 | 2.15 |
| shared bloom bump (by design "real") | 51.5% | 57.3% | 43.4% | 81.0% | 2.9% | 100% | 100% | 10.4 | 2.20 |

"min p over lags x m_eff" (what Bonferroni-by-m_eff formally covers) gives the same rate as "app" to the third decimal in every null row, so selecting by max |r| rather than min p is immaterial.

Power (p <= 0.05, 1,000 pairs each): cand = ref + k*noise. k = 0.2 (r ~ 0.98): 100%; k = 1.0 (r ~ 0.68): 96.9%, 94.3% with 20% missing; k = 2.0 (r ~ 0.45): 46.7%, 42.1% with missing. True lead of 3 samples: 96.5% (lag recovered 999/1000), with 20% missing 93.4% (969/1000); at r ~ 0.45: 45.7% (793/1000), with missing 41.8% (624/1000). Charging all 13 lags would have given 92.7% / 30.4% for the two full-data cases, so the per-pair penalty is doing what the Methods page claims.

Short overlaps (2,000 pairs each; "window" = 128-sample series with the candidate detected only in n contiguous samples): app rate n = 12: 1.9% / 4.9%, n = 16: 5.6% / 5.6%, n = 20: 5.4% / 5.2%, n = 30: 7.3% / 6.2%. At n <= 20 the ACF is truncated at n//5 <= 4 lags, so m_eff stays near 8-11 even for smooth series and the pair is over-charged, which offsets the under-discounted N_eff (0.8n at n = 10).

Family-wise (one reference vs 2,000 null candidates + 20 true positives, 10 at r ~ 0.95 and 10 at r ~ 0.55; BH via `_apply_fdr`, significant = q < 0.05): full data, 12 families: 130 discoveries, 0 false, power 54% (all strong ones, ~1 in 10 of the moderate ones); 20% missing, 12 families: 130 discoveries, 0 false, power 54%. Pure null, 10 families of 2,000: 0 false discoveries in every family (smallest null p per family 7e-5 to 4e-3; the 5.8-6.1% per-pair excess is far from the BH threshold once 2,000 tests are in play).

Li & Ji diagnostics: the lag-correlation matrix has at least one negative eigenvalue in 13-40% of pairs (truncated ACFs are not positive-definite) but the mean minimum eigenvalue is 0.00 (-0.002 at phi 0.95); the clip to [-1, 1] acts in ~1% of pairs (8% at phi 0.95). `abs()` is the Li & Ji definition; without it m_eff would be larger (4.6 vs 3.9) because f(lambda) = lambda - floor(lambda) gives 1 - |lambda| for a small negative lambda. Measured m_eff: white 12.65, phi 0.85 3.9, shared trend 2.15, matching the Methods page's "close to 13 / about 4 / about 2". N_eff median 30.0 for phi 0.85 matches "about 30".

---

## Checked and found correct

- **Lag sign, end to end.** For lag > 0, `_spearman_at_lags` pairs `ref[t+lag]` with `cand[t]`, so a high r means the candidate's value appears in the reference `lag` samples later: candidate leads. `check_lag.py`: a candidate peaking 2 samples earlier than the reference gives `best_lag = +2`; 3 samples later gives -3. The cache stores the lag relative to the low id and negates for a high-id reference; the fresh-compute path with the high id as caller's reference (the path AUDIT T2 says is untested) returns -2 and stores (1, 2, +2). The panel's `fmtLag` ("leads by" for positive hours) and its tooltips ("Positive = candidate peaks earlier") match. Swapping roles on 300 pairs with 20% missing values: r, p and n identical, lag exactly negated, 0 exceptions.
- **Effective N.** Formula matches the Methods page (sum to N//5, `(N-j)/N` weight, cap at N when the sum is <= 0, df = N_eff - 2, p = 1 when df < 1). It is computed on the transformed (raw/log/rank), co-observed values of the lag actually chosen (`core_scoring` is called on the shifted vectors). Dropping non-detected timepoints does not bias it the way one might expect: the compacted series is what is correlated, and its own (lower) autocorrelation is the right input; 20% random missingness moves the rate from 5.7% to 6.1%. The residual excess is the estimator (finding 3), not the gaps.
- **P-value pipeline.** t with N_eff - 2 df at the best lag, then Bonferroni by m_eff; `_lag_tests_m_eff`'s `cross(shift)` is sum_h acf_x(h) acf_y(h+shift), symmetric in the sign of the shift, diagonal exactly 1; using the lag-0 overlap for m_eff while p comes from the best lag is coherent (m_eff depends only on the ACFs). Selection across unequal per-lag subsets adds at most ~1 point (window case) over the lag-0 rate.
- **Family exclusions** (`check_family.py`, 12 fixtures, all pass): KEGG depth-1 ref excludes every other root and its whole subtree; a multi-parent depth-2 ref excludes both parents, siblings under both, and descendants while keeping cousins and nephews; a KO in two pathways excludes both pathways, their B/A ancestors and every KO in either pathway while keeping a cousin pathway and its KO; a pathway ref keeps a KO that only appears in a sibling pathway; enzyme generic walk handles NULL-parent roots and keeps nephews; taxonomy domain ref excludes other domains and its subtree; the `';'` guard stops "Bacteria;Proteo" being treated as an ancestor of "Bacteria;Proteobacteria;X"; COG multi-category in both directions; cross-source has no exclusions even with identical ids; species/strain refs deeper than the depth-6 cutoff exclude all ancestors (existing tests). `kegg_paths` is filtered to real `annotation_catalog` ids at migration (`migrate_kegg_paths_to_sql.py:51-64`), so the silent "depth None, self-exclusion only" fallback cannot be triggered by an id-format mismatch.
- **Cache.** Canonical (low, high, metric, method) key; both orderings hit the same row; IntegrityError re-reads the winner and negates its lag for a high-id reference; OperationalError returns the computed result uncached; `SELECT *` column positions (r=3, lag=6, p=7, n=8, at_p_floor=9) match the schema and the `ALTER TABLE ADD COLUMN` position.
- **FDR, sort, limit, counts.** BH over every scored candidate before truncation; `significant = q < 0.05`; sort (not significant, -|r|); counts are pre-limit totals. BH-adjusted values do not depend on the `alpha` passed.
- **Methods page numeric claims** that could be checked without the database: 13 lags 0..+/-6, 4 h/sample, limit 50/500 (pinned by `test_methods_page_facts.py`), 10-point floor, N/5, the m_eff landmarks, "about 30 independent observations", "N_eff never exceeds N", "rank ties averaged", log on co-observed positive values only.

## Not verifiable here

- The real timeline (gap positions) and therefore the exact lag_hours error distribution; the "median 29, middle half 23-37" and the urease / psbA / RuBisCO examples (no `hab_mappings.db`).
- The attribution of the `N/(N-j)` estimator to Pyper & Peterman is from memory of the paper; the simulation effect of using it is measured.
