# Metatrace (HAB Portal): Fresh Correctness Audit

| | |
|---|---|
| **This audit** | 2026-11-03, commit `a993ead`, branch `feature/sqlite-integration` |
| **Previous** | 2026-11-03 open-issues list (`docs/AUDIT-2026-11-03.md`, commit `d01f37c`) and the full 2026-09-22 audit (`docs/AUDIT-2026-09-22.md`) |
| **Scope** | A from-scratch review of everything that produces a number, a label, a chart or a relationship the user sees: the data pipeline (notebooks and migration scripts), the SQLite query layer and API routes, the correlation finder (statistics and speed), the chart components and statistics utilities, and every page and panel of the frontend. Items already listed as open in `docs/AUDIT-2026-11-03.md` are not repeated unless this review added something new. |
| **Method** | Seven independent reviewers, one per area, each briefed with the README and Methods page as the contract and told to verify by reading, by running the test suites, by writing small fixtures or simulations, and (read-only) against the live site. The coordinator re-verified every High finding by reading the code path and, where possible, by live request. Reviewer reports, probe scripts and simulation outputs are in `docs/audit-2026-11-03-artifacts/` (see the last section). |
| **Environment** | No local `hab_mappings.db` or raw JGI data, so DB-backed tests skip and some claims could only be checked live. Backend: `.venv/bin/python -m pytest tests/ -m "not api"` (404–410 pass; the only failures are the data-dependent files CI ignores). Frontend: Node 24 (`~/.vscode-server/bin/*/node`), `npx vitest run` 59 files / 1,470 pass; `tsc --noEmit -p tsconfig.app.json` clean. |

**Headline.** The core numbers are right. EGC, relative abundance, the hierarchy roll-up, EC renumbering, taxonomy lineage keying, the per-sample sums on the Taxonomy page, the chart x-axis and time zones, day/night bands (within 0.6 min of an independent solar computation), the tide alignment (0.000 m against NOAA at 240 points), Z-score, LOWESS, descriptive statistics, and the correlation finder's lag sign, effective-N p-value, Li & Ji penalty, family exclusions and FDR all check out, most of them numerically. What is wrong is at the edges where data reaches the user: a CSV export that is silently cut to an arbitrary 50,000 rows while promising "every row"; search boxes that cannot find the id forms the Methods page prints; exact ids buried under substring matches; a handoff that cannot find any taxon below domain; a "sibling" rule in the correlation finder that quietly drops thousands of KEGG candidates because BRITE protein-family tables are stored as pathways; and group totals that exceed the category's own total. The correlation finder's slowness has a measured cause and a validated 18–24× fix.

Each item has an ID (F = this audit), an **In plain terms** paragraph for non-specialists (what the issue is, when it shows up, why it matters), then **Where**, **What**, **Effect**, **Verified** (how, and by whom), **Fix**, and **Verify** (what a fixed state looks like). Severity: **High** = wrong or partial information presented to users as correct or complete, or a core function that does not work; **Medium** = wrong in realistic edge cases, or misleading; **Low** = hygiene.

---

## 1. High

### F1. Mappings "Export all" CSV is silently cut to 50,000 arbitrary rows

**In plain terms:** when you ask the Mappings panel to export every gene record for a large annotation, the server stops after the first 50,000 records and the file is handed over with no sign that it is incomplete. This happens for any annotation with more than 50,000 gene records across the 128 samples, which includes every COG category, every KEGG class and subcategory, and any abundant organism. The records you get are not a sensible subset either: they are whichever came first in the database's internal order, so whole samples are missing. Anyone analysing that file would believe they had the complete dataset.

**Where:** `FastAPI/api/cache_sql.py:1325-1372` (every variant of the id subquery ends in `LIMIT {_MAPPINGS_ROW_LIMIT}` regardless of `bypass_cap`); `FastAPI/api/routes.py:399-406` (`bypass_cap` skips only the sample budgeting); `frontend/src/components/mappings/MappingsPanel.tsx:166-181` (`downloadFullCsv` reads `r.data` and never looks at `results_were_truncated`); `MappingsPanel.tsx:290-291` ("Export all downloads every mapping row for this annotation across all 128 samples").

**What:** `bypass_cap=true` disables the 5-sample cap and the whole-sample row budgeting but not the hard row limit, so the export query returns the first 50,000 ids in index order. For kegg that is `(kegg_id, sample)` order: a prefix of the leaf ids in lexicographic sample order, neither whole samples nor chronological. The on-screen truncation note (`MappingsPanel.tsx:366-378`), which does say Export all cannot go past 50,000, appears only when the *preview* hit the limit; a preview that was merely sample-capped shows the "every mapping row" promise instead.

**Effect:** Analyze → KEGG pathway 00910 (Nitrogen metabolism) → View Annotation Mappings. Live: preview capped to 5 samples, 7,358 rows, `results_were_truncated=false`, so the panel offers "↓ Export all … every mapping row … across all 128 samples". The pathway has 253,121 mapping rows (sum of `gene_count` from `/annotations/scaffolds/summary`). The CSV contains 50,000 of them, an arbitrary subset, with no warning in the file or the UI. Every COG category, every KEGG A/B level and every abundant organism behaves the same.

**Verified:** code read (coordinator); fixture `artifacts/api/probe_fixture.py` PROBE1 (6 rows, limit 4, `bypass_cap=True` → 4 rows); live preview and gene counts for 00910. The bypass export itself was not run live (multi-minute query).

**Fix:** either stream the full result for `bypass_cap` (iterate samples chronologically, no LIMIT), or keep the limit but have the route return `results_were_truncated` for the export and have `downloadFullCsv` refuse or warn when it is set. The "every mapping row" text must be conditional on the real total (`SUM(gene_count)` from `annotation_series`, already computed by `samples_within_row_budget`).

**Verify:** export of a node with >50,000 rows either contains every row or is refused with a message; the note never promises "every row" for such a node.

### F2. Search cannot find ids written with their `KO:`/`EC:` prefix, and `EC:…` returns the wrong source

**In plain terms:** if you type an enzyme or KEGG id the way the Methods page writes them, with the EC: or KO: prefix, the search boxes on Analyze, Compare, Taxonomy and the Lookup page either find nothing or find the wrong thing. For EC:1.1.1.1 you get a list of KEGG orthologs whose names happen to mention similar EC numbers, and not the enzyme itself. This shows up whenever a user copies an id from a paper, from KEGG, or from this app's own documentation. A user who trusts the result charts or correlates the wrong annotation.

**Where:** `FastAPI/api/routes.py:496-504`, `FastAPI/api/cache_sql.py:897-913` (`get_search_annotations` matches `q` and `annotation_id` verbatim; `strip_source_prefix` is applied by `/series/annotations` and `/mappings/search` but not here); callers `AnalyzePage.tsx:820-826`, `ComparePage.tsx:388-393`, `TaxonomyPage.tsx:83-85`, `ExplorePage.tsx:1349` (Lookup); documented id forms `MethodsPage.tsx:69-73` ("EC:1.1.1.1 · EC:4.2.1.17").

**What:** the catalog stores bare ids (`1.1.1.1`, `K00001`). `q=KO:K00001` matches nothing. `q=EC:1.1.1.1` matches only KO *names* containing that text (`fabG [EC:1.1.1.100]`, `paaH [EC:1.1.1.157]`, …).

**Effect:** Explore → Annotation Lookup, Enzyme, "EC:1.1.1.1": 0 results. Analyze or Compare, all sources, "EC:1.1.1.1": 41 KEGG orthologs, none of them alcohol dehydrogenase, zero enzyme rows. "KO:K00001": nothing.

**Verified:** live (coordinator): `q=EC:1.1.1.1&sources=enzyme` → total 0; `q=KO:K00001` → total 0; `q=K00001` → 1. Also found independently by two reviewers.

**Fix:** in `get_search_annotations`, strip a leading `KO:`/`EC:` from `q` (and from the `annotation_id` exact branch), or match `annotation_id IN (bare, 'KO:'||bare, 'EC:'||bare)`. Add a route test for both prefixed forms.

**Verify:** `q=EC:1.1.1.1&sources=enzyme` returns 1.1.1.1 first; `q=KO:K00001` returns K00001.

### F3. An exact id is not ranked first, so a looked-up id can be absent from the Lookup result and is never auto-selected

**In plain terms:** searching for an id such as 2.7.1.1 also matches every longer id that starts with it, like 2.7.1.10 and 2.7.1.170, and the results are ordered by abundance rather than by whether they are the thing you typed. On the Lookup page, which shows only 25 results, the exact id can be missing from the list entirely, so there is no way to open it from there. This affects any EC number that is a prefix of other numbers, which is most of them, and KEGG pathway codes that appear inside KO ids. The page tells the user that exact ids return one result, which is not what happens.

**Where:** `FastAPI/api/routes.py:507` (sort by `mean_egc` only), `FastAPI/api/cache_sql.py:907-913` (`LIKE '%q%'` on id and name, no exact-match term); `frontend/src/pages/ExplorePage.tsx:1349` (`page_size=25`), `:1356` (auto-select only when exactly one result), `:1900` ("exact IDs return one result; general terms return a ranked list").

**What:** an EC number is a substring of every longer EC number that starts with it (`2.7.1.1` is inside `2.7.1.10 … 2.7.1.199`); the exact match sits wherever its mean EGC puts it and the Lookup page fetches only 25 rows.

**Effect:** Explore → Annotation Lookup, Enzyme, "2.7.1.1" (hexokinase, 80 samples in the catalog): "62 results · showing 25 · sorted by mean EGC", hexokinase not among them. "1.1.1.2" is at 15, "1.1.1.4" at 17, "1.1.1.1" at 3 (visible but not selected). `q=00010` (kegg) returns 00010 and K00010. Analyze loads 5,000 rows so the exact id is present but at the same rank.

**Verified:** live (coordinator): `q=2.7.1.1&sources=enzyme&page_size=100` → total 62, exact id at position 43.

**Fix:** `ORDER BY (annotation_id = :q OR name = :q) DESC, mean_egc DESC` (bare and prefix-stripped), then paginate; in Lookup, call `/search/annotations?annotation_id=<id>` first when the trimmed query looks like an id and auto-select the hit. Update `tests/sql/test_search_annotations_sql_route.py::test_results_sorted_by_mean_egc_descending` to allow the exact match first.

**Verify:** Lookup of "2.7.1.1" shows hexokinase first and selects it.

### F4. "View Timeseries in Analyze" cannot find any taxonomy row below domain level

**In plain terms:** the "View Timeseries in Analyze" button on the Lookup page sends the full lineage string, such as Archaea;Euryarchaeota, to the Analyze search box, and the Analyze search only matches taxonomy by the bare name. So for any taxon below the domain level the button lands you on a page saying no annotations were found. It works for the four domains and for KEGG, COG and EC ids, which is why it was not noticed.

**Where:** `frontend/src/App.tsx:171-183` (`handleSendToAnalyze` puts `annotationId` into `queryFields` and sets `autoRunSearch`) → `frontend/src/pages/AnalyzePage.tsx:810-838` (`runSearch` sends it as free-text `q`); origin `ExplorePage.tsx:2331`. Backend `cache_sql.py:899-909` matches taxonomy rows on `name` only.

**What:** for taxonomy the id is the full lineage (`Archaea;Euryarchaeota`); as a free-text query it matches nothing. Works only for the four domain names and for kegg/cog/enzyme ids.

**Effect:** Explore → Annotation Lookup → taxonomy → "Euryarchaeota" → View Timeseries in Analyze → Analyze shows `No annotations found for "Archaea;Euryarchaeota"`.

**Verified:** live (coordinator): `q=Archaea;Euryarchaeota&sources=taxonomy` → total 0 while `q=Euryarchaeota` → 9; code read of the handoff; reviewer's App-level test (`artifacts/frontend/audit-app-handoff.test.tsx`) rendered the "No annotations found" box.

**Fix:** hand over an exact-id request (`annotation_id=` + `sources=<source>`) instead of a free-text query, or at least `bareTaxonName(id)` for taxonomy. Pin with the handoff test.

**Verify:** the handoff from a genus-level taxonomy row lands on Analyze with that exact taxon selected.

### F5. Same-source KEGG correlations silently exclude every KO that shares a BRITE protein-family table with the reference; BRITE tables are listed as pathways

**In plain terms:** KEGG's hierarchy file contains real metabolic pathways but also large catalogue tables such as "Transporters" or "Transcription factors", which group thousands of genes by protein family rather than by what they do together. The pipeline stores these tables as if they were pathways. Two things follow. First, when you look for KEGG correlates of a KEGG reference, the finder excludes "siblings", meaning anything sharing a parent, to avoid trivially related results; because the catalogue tables count as parents, a search starting from a transporter silently throws away all 2,260 other transporters, including the ones a user would most want to see, and the panel only says siblings were excluded. Second, the Explore page's pathway rankings and the pathway-level bulk downloads list these catalogue tables alongside real pathways, and because they are so large they come out on top.

**Where:** `Notebooks/EGC_KEGG_TREE.ipynb` cell 5 (parses every A-section of `ko00001.keg`, including `A09180 Brite Hierarchies` and `A09190 Not Included in Pathway or Brite`) and cell 7 (walks every occurrence); `FastAPI/scripts/migrate_kegg_paths_to_sql.py:97-130` (one `kegg_paths` row per occurrence, no section tag); `FastAPI/api/routes.py:974` (`"pathway": 3`); `FastAPI/api/correlation_sql.py:269-282` (siblings = every `d_id` under any of the reference's immediate `c_id` parents).

**What:** 81 of the 571 depth-3 KEGG nodes are not pathway maps: 56 BRITE tables (`02000 Transporters [BR:ko02000]` 2,260 KOs, `03000 Transcription factors` 1,519, `04131 Membrane trafficking` 1,468, `03036 Chromosome and associated proteins` 1,241, `01002 Peptidases and inhibitors` 1,064), 24 "Not Included" groups (`99980 Enzymes with EC numbers` 1,589 KOs, …) and `09113 Global maps only`. Nothing in `annotation_series` or `kegg_paths` distinguishes them, and the Methods page describes KEGG only as "pathway class → subcategory → pathway → KO".

**Effect:**
1. Correlation finder, KEGG vs KEGG: K02014 (TonB-dependent receptor) has one immediate parent, `02000 Transporters`, so all 2,260 transporter KOs are excluded as "siblings" (1 would be from pathway parents alone). K03924 (moxR): 1,589 excluded via `99980` (vs 1). K00844 hexokinase: 2,248 excluded vs 864 from its 13 real pathways. The panel says siblings/ancestors/descendants are excluded; the user cannot tell that "siblings" means every transporter in KEGG, and the README's justification (compositional and containment artifacts) does not apply to BRITE co-membership.
2. Explore → Top EGC / Annotations by Parent / Bulk Download at level "pathway" list `Transporters [BR:ko02000]`, `Enzymes with EC numbers`, `Transcription factors [BR:ko03000]` as pathways; with 1,000–2,300 members each they sit at the top of any pathway ranking. The `[BR:…]` suffix is the only hint.

**Verified:** code read of the exclusion SQL (coordinator); counts computed with the migration script's own `iter_kegg_path_rows` and a line-for-line replica of `_kegg_family_exclusions` on today's live `ko00001.keg` (`artifacts/pipeline/kegg_sibling_experiment.py` and `.out`). The deployed May-2026 file may differ by a few KOs.

**Fix:** `a_id` is already in `kegg_paths`. In `_kegg_family_exclusions`, restrict the *sibling* step to parents whose `a_id` is one of the six pathway classes (`09100`–`09160`) or whose `c_name` contains `[PATH:`; keep BRITE/"Not included" occurrences for ancestor/descendant exclusion and the hierarchy popup. Label depth-3 nodes without `[PATH:` as "BRITE table" / "group" in Explore and Bulk Download, and say on the Methods page that the KEGG tree includes BRITE tables. Add a test with a KO whose only parent is a BRITE table.

**Verify:** K02014 vs kegg tests ~12,800 candidates (not ~10,600); the panel or Methods page says what a sibling is.

### F6. "Σ Mean EGC" group totals exceed the category's own EGC and cover only the members in the top 200

**In plain terms:** on the Dataset Overview and Annotations by Parent views, a category's size is shown as the sum of its members' mean EGC. For KEGG and COG a member can belong to several categories, and the hierarchy itself counts each gene only once per category, so adding the members together double-counts and gives a number larger than the category's own total. On live data "Metabolism" comes out 55% too large and "Carbohydrate metabolism" 61% too large, while taxonomy categories are almost exact. The sum also only includes members that made it into the top-200 list. A reader comparing category sizes, or comparing KEGG against taxonomy, is comparing numbers computed on different bases.

**Where:** `frontend/src/pages/ExplorePage.tsx:225-245` (Overview `sumEgc`), `:432` ("Top Functional Groups by Σ Mean EGC"), `:728-756` (By Parent `sumEgc`), `:850`, `:861` (tooltip: "useful for ranking which functional categories dominate the dataset"). Both panels load `/annotations/top?limit=200` and sum `mean_egc` of the members among those 200 rows, filing multi-parent rows under every real parent.

**What:** (a) a KEGG pathway or KO in several subcategories counts once per member, so Σ(member means) exceeds the category's own roll-up, in which each gene counts once; (b) Σ covers only members in the top 200; (c) the Overview shows both numbers for the same category (own mean under "Top-level categories", inflated Σ in the ranked list) without saying which is the category's size.

**Effect (live, kegg):** the 200 rows are 8 A-level, 41 B-level, 150 C-level, 1 KO. "Metabolism" Σ = 6.56e6 (11 members) vs own mean 4.22e6 (+55%); "Carbohydrate metabolism" 1.58e6 vs 9.85e5 (+61%); 09105 +47%; "Brite Hierarchies" +11%. Taxonomy groups come out at 0.94–1.00 of the parent's own mean, so the error direction depends on source and the cross-source ranking is not comparable. "∑ Summed by parent" ranks categories by this statistic.

**Verified:** reviewer's live recomputation from `/annotations/top?source=kegg&limit=200` + `/kegg/parents` and `source=taxonomy` (raw responses in the session scratchpad; the arithmetic follows directly from the code at the lines above).

**Fix:** show the parent's own `mean_egc` as the group total (available in the same response and the catalog) and label the member sum "Σ of listed members (overlapping)"; at minimum state in both tooltips that a group's Σ can exceed the category's own EGC and covers only the members shown.

**Verify:** for kegg "Metabolism" the displayed group total equals its catalog `mean_egc`.

---

## 2. Medium

### F7. Z-score is standardised over the visible date window; the Methods page says "across the bloom"

**In plain terms:** the Z-score option expresses each point as the number of standard deviations from the series mean. The chart computes that mean and spread from only the points visible in the chosen date range, while the Methods page says it is across the whole bloom. So narrowing the date range changes the Z value of every point, and the axis label does not say so. The exported CSV records that the values were standardised but not over which window.

**Where:** `frontend/src/components/charts/EgcChart.tsx:204-240` (`filteredPoints` → `unsmoothedPoints` → `applyZScore`), `MultiEgcChart.tsx:107-164`, `GroupedEgcChart.tsx:72-117`; `MethodsPage.tsx` Z-score item; `chartCsv.ts:21,45,80` (`standardized: true` with no window recorded).

**What:** μ and σ come from the points surviving the date range (and, on Analyze, the Timepoints date/time pills), not the full series. The same sample's Z changes with the window; the axis still says "σ from mean". `applyZScore` itself is correct (population σ, n<2 unchanged, constant → 0).

**Effect:** Analyze card, Z-score on, full range: a 5 June point reads "+1.2σ"; narrow to 1–7 June and the same point reads "−0.3σ" with no label change. Compare has Z-score on by default.

**Verified:** code read (coordinator and reviewer).

**Fix:** standardise on the unfiltered series then filter, or change the Methods sentence to "mean over the samples currently shown" and add the window (`standardized_over_n`, `date_from`, `date_to`) to the CSV and the Stats panel title.

**Verify:** either a point's Z is independent of the window, or the label says what the window is.

### F8. Correlation "leads/lags by N h" is a nominal conversion; across the 8–12 h gaps the true offset is up to 12–16 h larger

**In plain terms:** the correlation finder reports a lead or lag in hours by counting samples and multiplying by four. The sampling schedule has a few gaps of 8 or 12 hours, so a shift of three samples is sometimes 12 hours and sometimes 16 or 20. A row labelled "lags by 12h" is therefore approximate, and the window advertised as "up to a full day" can reach well beyond that for part of the series. Nothing in the UI or on the Methods page says the hours are nominal.

**Where:** `FastAPI/api/correlation_sql.py:728` (`lag_hours = lag_samples * 4`); `CorrelatesPanel.tsx:182-187, 406-409`; `MethodsPage.tsx:262-266` ("0–24 h at 4 h per sample", "up to a full day of lead or lag"). Acknowledged only in a backend docstring (`correlation_loaders.py:51-57`).

**What:** lags are index shifts over `sample_order`; hours multiply by 4 regardless of the gaps. Under plausible gap placements (128 samples over ~133 four-hour slots; `artifacts/correlation-math/gap_arith.py`): at lag 1, 2–4% of contributing pairs have a true offset of 8–12 h; at lag 3, 6–12% span 12–20 h; at lag 6, 12–25% span 24–32 h (40 h if two gaps are adjacent). The r at that lag is computed with those misaligned pairs mixed in.

**Effect:** a row labelled "lags by 12h" may lag by 12–20 h for part of the series; "up to a full day" understates the window.

**Verified:** arithmetic under four gap placements (reviewer); the real timepoints CSV is not in this checkout, so placements are assumed.

**Fix:** say on the Methods page and in the panel tooltip that lag hours are nominal (4 h per sample; 8–12 h across the gaps), or compute the lag on the real time axis (shift by hours, pair by nearest timestamp).

### F9. Under the null, 37% of candidates are labelled with the window-edge lag (±24 h)

**In plain terms:** for each candidate the finder tries 13 time shifts and reports the one with the strongest correlation. For two series that are not related at all, that strongest shift is most often one of the two extreme shifts, plus or minus 24 hours, simply because that is how the maximum of a smooth random curve behaves. The panel prints the shift for every row, so weak non-significant rows often read "leads by 24h" as if that were a property of the pair. It is an artefact of the search, not of the data.

**Where:** `correlation_sql.py:192-218` (best |r| over 13 lags); `CorrelatesPanel.tsx:360-410` shows the lag for every row, significant or not.

**What:** for smooth series the cross-correlation across neighbouring lags is a smooth random function whose maximum over a bounded window sits at an endpoint far more often than anywhere else. Simulation (independent AR(1) φ=0.85, n=128, Spearman, 8,000 null pairs): |lag| = 6 chosen 37.1% of the time, |lag| = 1..5 about 11% each, lag 0 only 5.4%. Among the top 5% of null pairs by |r| (the non-significant tail the panel shows), 32% carry "leads/lags by 24h". True relationships are unaffected: a true lag-0 pair with r ≈ 0.68 is reported at lag 0 in 1000/1000 runs; a true lead of 3 samples is recovered 999/1000. The coordinator's independent run of the performance prototype on synthetic data showed the same pile-up (±6 chosen for 24% of 2,520 candidates).

**Effect:** a weak non-significant row reads "+0.54, lags by 24h, q=0.6, n=128" as confidently as a significant one; the 24 h is an artefact of the search window.

**Verified:** simulation (`artifacts/correlation-math/sim_followup.py`). The p-value at edge lags is not inflated (4.7% at |lag| = 6), so the FDR is unaffected.

**Fix:** show the lag only for significant rows (or grey it out otherwise) and mark lags at the window edge as "at search limit (≥ 24 h)"; mention on the Methods page that for unrelated pairs the chosen lag tends to the edge of the window.

### F10. Per-pair false-positive rate is 5.8% with full data and up to 7.3% with structured missingness; the cause is the autocorrelation estimator (root cause of open item CR2)

**In plain terms:** to get an honest p-value from autocorrelated time series, the finder estimates how many independent observations the 128 samples are really worth. The formula it uses expects an autocorrelation estimate that has been corrected for the shrinking number of pairs at long lags; the code feeds it the uncorrected estimate, so long-lag autocorrelation is discounted twice and the effective sample size comes out slightly too generous. The measured effect is that about 6% of unrelated pairs pass at the 5% level instead of 5%, rising to about 7% when a candidate is detected only in part of the series. The family-wise FDR correction absorbs this in practice, so the significant / not-significant verdicts are not affected, but the raw p-values are slightly optimistic. The fix is two lines, but it changes cached p-values, so it has to ship with a cache clear.

**Where:** `correlation_sql.py:100-104` (`_autocorrelations`: biased estimator, denominator over all N terms) feeding `_effective_n` at `:127`, which then applies the `(N−j)/N` weight.

**What:** in Pyper & Peterman (1998) the `(N−j)/N` weight is paired with the bias-corrected `N/(N−j)` autocorrelation estimator; applying it on top of the already-shrunk biased estimator discounts long-lag autocorrelation twice, so N_eff is slightly too large and p slightly too small. Multiplying the ACF by `n/(n−j)` inside `_effective_n` (two lines) moves the lag-0 rate to 5.1–5.6% in every condition tested. Structured missingness (candidate detected only in a contiguous 80-sample window) is the worst case: 6.4% at lag 0, 7.3% after the lag search.

Simulation table (independent AR(1), n=128, 3,000–6,000 pairs per row, p ≤ 0.05; "app" = `score_pair` as deployed):

| condition (Spearman unless noted) | app | lag-0 eff-N | lag-0, N/(N−j) ACF | naive lag 0 | naive best lag | N_eff median | m_eff mean |
|---|---|---|---|---|---|---|---|
| full data | 5.8% | 5.7% | 5.1% | 38.6% | 78.9% | 30.0 | 3.91 |
| full, raw Pearson | 5.8% | 5.9% | 5.3% | 40.3% | 80.3% | 28.6 | 3.85 |
| full, log-Pearson | 5.7% | 5.9% | 5.2% | 40.7% | 80.2% | 28.6 | 3.85 |
| 20% missing at random | 6.2% | 6.1% | 5.6% | 30.1% | 74.5% | 28.2 | 4.87 |
| candidate detected only in an 80-sample window | 7.3% | 6.4% | 5.4% | 37.7% | 79.3% | 21.7 | 4.20 |
| window + 20% missing | 6.9% | 7.1% | 5.9% | 30.4% | 76.2% | 20.3 | 5.37 |
| φ = 0.95 | 6.2% | 6.6% | 5.5% | 60.9% | 86.5% | 16.1 | 2.93 |
| φ = 0.50 | 5.3% | 5.1% | 5.0% | 11.9% | 62.7% | 84.5 | 7.98 |
| white noise | 3.5% | 4.5% | 4.5% | 4.8% | 47.4% | 128 | 12.65 |
| shared linear trend (counts as real by design) | 39.8% | 50.5% | 29.1% | 99.7% | 99.8% | 9.8 | 2.15 |
| shared bloom bump (counts as real by design) | 51.5% | 57.3% | 43.4% | 100% | 100% | 10.4 | 2.20 |

Family-wise: one reference vs 2,000 null candidates + 20 true positives, BH via `_apply_fdr`, 24 families: 130 discoveries, 0 false; 10 pure-null families of 2,000: 0 false discoveries. Power at p ≤ 0.05: r ≈ 0.98 100%; r ≈ 0.68 96.9% (94.3% with 20% missing); r ≈ 0.45 46.7%.

**Effect:** none at the significant/not-significant boundary in practice (BH absorbs it). It affects the raw `p` of the single-pair endpoint and the order of borderline q-values. Note that the Methods page's "about half of unrelated but smooth pairs pass" the naive test is 39–41% at one lag and 79–80% after the lag search.

**Verified:** simulation (`artifacts/correlation-math/sim_null.py`, outputs `sim_null.json` / `sim_null.log`). The attribution of the `N/(N−j)` estimator to the paper is from the reviewer's memory of it; the simulated effect is measured.

**Fix:** use the `N/(N−j)`-corrected estimator in `_effective_n` (and for consistency in `_lag_tests_m_eff`); re-run `TestEffectiveNFalsePositiveRateSimulation` and tighten its bar from 7% to 6%; update the Methods paragraph ("about 40% at a single lag, about 80% after searching the lags"). Any change to `score_pair` must also clear or version the cache (open item N3).

### F11. Top EGC Annotations ranks roll-up categories next to their members and cannot show the top N at a rank

**In plain terms:** a category's EGC is the sum of everything under it, so a list of the top 25 annotations by EGC is almost entirely top-level classes and subcategories, never individual KOs or enzymes. The rank buttons on the Top EGC view only filter the rows already fetched, so you cannot ask for the top 25 KOs; you get however many KOs happened to be in the top N overall, which at N = 25 is none. The Methods page says top-level categories are shown separately on the Explore page, which is true of the other views but not this one.

**Where:** `FastAPI/api/routes.py:762-831` (`/annotations/top` has no depth parameter); `ExplorePage.tsx:1252` (fetches `limit=N`), `:1420-1436` (rank pills filter the already-fetched rows), `:1639` ("doesn't re-fetch, just filters what's already loaded"); `MethodsPage.tsx:122-125` says top-level categories "are shown separately on the Explore page instead of being ranked next to the groups they already contain", which is true of Dataset Overview and Annotations by Parent but not this view.

**What:** every ancestor's EGC is the sum of its descendants, so the server's top N is dominated by roll-ups. Live: `source=kegg&limit=25` returns 8 depth-1, 13 depth-2, 4 depth-3 and zero KOs; `taxonomy&limit=25` mixes all eight ranks. The rank pills can only subtract, so "top 25 KOs" is unobtainable and a filtered list has an unspecified length.

**Effect:** Explore → Top EGC Annotations, KEGG, 25: #1 "09180 Brite Hierarchies", #2 "09100 Metabolism".

**Verified:** live `/annotations/top` depth distributions; code read (reviewer).

**Fix:** add `depth` (or `min_depth` / `exclude_top_level`) to `/annotations/top`, push it into both SQL paths (`AND depth = ?` on `annotation_catalog`), include it in the cache key, and have the view send the selected rank. Qualify the Methods sentence until then.

### F12. Scaffold Information and Bulk Download searches have no sequence guard; a late result lands under the new source and is added with the wrong source

**In plain terms:** in the Scaffold Information and Bulk Download panels, if you start a search and then change the source dropdown before the results arrive, the results from the old source are shown under the new source's label, and clicking one adds it tagged with the wrong source, which then fails to load. It takes a quick hand or a slow server to trigger, which is exactly the situation on an uncached request.

**Where:** `frontend/src/components/scaffolds/ScaffoldExplorePanel.tsx:309-324` (`runSearch`), `:326-332` (`handleSourceChange` clears results but cannot cancel the in-flight response), `:623` (`addTerm(r.annotation_id, searchSrc)` uses the live dropdown, not `r.source`). Same pattern in `BulkDownloadPanel.tsx:252-266` / `:268`.

**Effect:** search "Bacillus" in taxonomy, switch to kegg while loading: taxonomy results appear under kegg; clicking adds a term tagged `kegg` with a lineage id, which reads "failed to load" (summary 404). In Bulk Download the mismatched start term makes the size request fail. Two quick searches can show the older query's results.

**Verified:** reviewer's vitest probe against the real component (deferred `/search/annotations` promise, change the `<select>`, resolve, click): the summary request was `source=kegg&annotation_id=Bacteria;Firmicutes…`.

**Fix:** the `requestSeqRef` pattern already used in `ExplorePage.tsx`; add the term with `r.source ?? searchSrc`.

### F13. Compare page: duplicate entries, colour collisions and silently dropped groups on handoff

**In plain terms:** three bookkeeping slips on the Compare page. Using "Select top N" and then "Add selected" can add an annotation that is already on the chart, so it is drawn twice in two colours and uses up one of the four slots. Sending a series over from Analyze resets the colour sequence, so the new series can get the same colour as one already there and the two lines cannot be told apart. And if two different groups happen to carry the same label, such as "iron (2)", the second one is dropped without any notice.

**Where:** `ComparePage.tsx:456-462` ("Select top N" builds keys from `searchResults.slice(0, slotsRemaining)` without excluding rows already added) and `:415-451` (`addSelectedAnnotations` has no duplicate check, unlike `addAnnotation` at `:469-472`); `:148` (`resetSourceCounters()` on every handoff) with `:163-166`; `:134-140` (handoff keys are `group:${label}` and the label is `${searchTerm} (${n})`, so two different "iron (2)" groups collide; filtered-out items are not added to `handoffSkipped`).

**Effect:** with K00001 open, search "K000", "Select top 3", "+ Add 2 selected": K00001 gets two chips and is drawn twice (two colours, both in the CSV), using one of the four slots. Add K00001 on Compare (kegg shade 0), go to Analyze, send K02014: also shade 0, indistinguishable lines. A second "iron (2)" group handed over vanishes with no notice.

**Verified:** three reviewer probe tests fail under current code (`artifacts/frontend/audit-compare.test.tsx`; run by copying into `frontend/src/tests/`).

**Fix:** exclude rows already in `state.entries` from select-all and `toAdd`; do not reset colour counters on handoff (only when the page becomes empty); key handoff groups by their sorted member set and report skipped ones.

### F14. Same-named taxa at different depths get an identical hint and cannot be told apart

**In plain terms:** when two taxa share a name, the app appends a hint such as "in Archaea" to tell them apart. If they share a name because the lineage repeats it at several ranks, which JGI's "unclassified X" placeholders do, the hint is the same for both and they cannot be told apart on the Compare page chips or in the chart legend.

**Where:** `frontend/src/utils/taxonomy.ts:247-273` (`homonymHints`); used by `LeftResultList.tsx:151,333-341`, `ComparePage.tsx:508-510,768`, the MultiEgcChart legend.

**What:** the loop starts at `min(len)−2` and walks up while segments agree; when one lineage is a prefix of the other it bottoms out at index 0 for both, so both get the domain as hint.

**Effect:** a search for "Euryarchaeota" returns `unclassified Euryarchaeota` at depths 3, 4, 5 and 6; on Compare every chip and legend entry reads "unclassified Euryarchaeota · Archaea", so two such overlays cannot be distinguished.

**Verified:** live search; reviewer unit probe fails (`'Bacteria'` for both).

**Fix:** when hints collide, append `taxonomyRankLabel(depth)`.

### F15. External link for an EC class/subclass/sub-subclass opens an empty KEGG page

**In plain terms:** for an enzyme class or subclass such as 1.1.1, the external link points to a KEGG page that does not exist, so for every non-leaf enzyme entry the only link offered is a dead end.

**Where:** `frontend/src/components/ui/ExternalLinks.tsx:153-163` (partial EC padded to `ec:1.1.1.-` and linked to `genome.jp/entry/ec:1.1.1.-`); `tests/external-links.component.test.tsx:184` pins `ec:2.7.-.-`.

**Effect:** the Lookup card and Analyze info drawer for every non-leaf enzyme node offer one link, which opens "KEGG ENZYME: 1.1.1.-" with body "No such data". ExPASy is correctly suppressed for partial ids.

**Verified:** live GET to genome.jp (200, "No such data"); `https://enzyme.expasy.org/EC/1.1.1.-` returns a real page.

**Fix:** BRITE browser query (`show_brite?htext=ko01000.keg&query=1.1.1`) and/or the ExPASy class page; update the pinned test.

### F16. The Mappings panel never shows the gene or scaffold of a row, and "rows" are genes

**In plain terms:** each row in the Mappings panel is one gene, but neither the table nor the CSV shows the gene id or the scaffold it sits on. Identical-looking rows cannot be distinguished, the row count is really a gene count without saying so, and the export cannot be matched back to the JGI files or to the scaffold panels.

**Where:** `frontend/src/components/mappings/MappingsPanel.tsx:380-405` (columns: Date, Time, Taxonomy, KEGG, Enzyme, COG) and `mappingsData.ts:85-105` (CSV has the same fields). The API row carries `gene_id` and `contig_id`; `get_mappings_sql` returns one row per gene (`cache_sql.py:1360-1409`, `GROUP BY mappings.id`, several COGs/ECs comma-joined).

**Effect:** "17 rows" is 17 genes but the user cannot see that, cannot tell identical-looking rows apart, and the CSV cannot be joined to JGI files or the scaffold panels. With "Unique pairs" the gene count is lost. (`MappingsPanel.tsx:17` says 100 rows/page; `MAPPINGS_PAGE_SIZE` is 25.)

**Verified:** code read; live request.

**Fix:** add Gene and Scaffold columns (at least to the CSV); say "N genes".

### F17. `include_parent=true` returns 500 for a parent that has no detected data (API only)

**In plain terms:** an API-only bug. Asking for a bulk export with include_parent for a term that exists in the hierarchy but was never detected in any sample returns a server error instead of a clear "no data" response. The web UI cannot trigger it.

**Where:** `FastAPI/api/routes.py:1076-1078` (`next(p for p in get_paths_under_at_depth_sql(...) if p["annotation_id"] == parent)` with no default; `get_paths_under_at_depth_sql` only returns terms with a catalog row).

**Effect:** `/series/export` and `/series/export/summary` answer 500 instead of 404 for a term present in the paths tables but never detected. The Bulk Download panel picks start terms from the catalog, so the UI cannot reach it. The lookup also fetches every term at `parent_depth` to find one.

**Verified:** fixture (`artifacts/api/probe_fixture.py` PROBE2).

**Fix:** `next(..., None)` → 404, or query the paths table directly.

### F18. Candidates with fewer than 10 shared timepoints are dropped silently; "every candidate in the family is tested" is not quite true

**In plain terms:** candidates that share fewer than 10 detected timepoints with the reference cannot be scored and are dropped silently. The panel's "N tested" count excludes them and the Methods page says every candidate is tested, so a user cannot tell that some candidates were never considered.

**Where:** `MethodsPage.tsx:281-282`; `correlation_sql.py:718-719, 752` (`tested_count = len(scored)`).

**What:** `score_pair` returns None for <10 co-observed points or a constant candidate; those are dropped before FDR and never counted. BH over the scored set is the right family, but the page says every candidate is tested and the panel's "N of M" never says some were untestable. Such pairs are also never cached, so they are recomputed on every request (see X1).

**Fix:** return an `untested_count` and show "M scored; K had fewer than 10 shared timepoints"; soften the Methods sentence.

---

## 3. Low

Grouped by area. Each is a one-liner with the location; none changes a headline number.

**Correlation finder**
- `CorrelatesPanel.tsx:355-366, 421-432`: rows with n < 30 are dimmed and called "not statistically reliable" even when significant; the effective-N test already accounts for that. `METRIC_LABEL.norm_egc` is "norm EGC" while everywhere else it is "Relative Abundance".
- `CorrelatesPanel.tsx:5-6`: header comment "ranked by |r|" predates the significant-first sort. No frontend test asserts the "leads by"/"lags by" text for a non-zero lag (only lag 0 is tested); given CR1's history this mapping deserves a test.
- `correlation_sql.py:564-571`: single-pair `/correlation` with an unknown catalog id raises `TypeError` → 500 instead of 404. The frontend never calls this endpoint.
- `correlation_sql.py:165-167`: `_lag_tests_m_eff` uses the lag-0 overlap; if that has <10 points but the chosen lag had ≥10, the pair is charged the full 13 (conservative, rare).

**API**
- `routes.py:797-801` with `index.py:89-94`: the `/annotations/top` cache key conflates `date_to=2021-06-05` (whole day) with `2021-06-05T00:00:00` (midnight); whichever is asked first is served for both for 30 min. The UI sends only bare dates.
- `routes.py:231, 245` and `cache_sql.py:106`: `/timepoints` and `/samples` are not chronological (dict order of the CSV / `ORDER BY sample`); the app sorts client-side.
- `cache.py:112-131`: `/tides` labels only the high/low events that fall on the 6-minute grid (on 2021-06-03 NOAA lists four extrema; the API labels one). The frontend ignores `tide_event`.
- `routes.py:855-859, 900`: `/annotations/scaffolds` and `/summary` reject `EC:`/`KO:`-prefixed ids that the other routes accept.
- `routes.py:429`: `results_were_truncated` is true when the result is exactly 50,000 rows. Fetch `LIMIT + 1`.
- `routes.py:170-190`: `_TOP_ANN_CACHE_SQL` is read and mutated from threadpool threads without a lock; two expiring requests can both `del` the key, or `move_to_end` can follow a concurrent `popitem`, raising `KeyError`. Rare.
- `routes.py:281` returns `"tz_offset": -7` literally instead of `LOCATION_TZ_OFFSET`; `routes.py:293` `le=128`; `index.py:105` derives the date range from all 132 CSV rows while `/timepoints` filters to 128 (no effect today).
- `endpoint_query_reference.md` describes a Mongo/in-memory architecture (`/annotations/correlate`, `/mongo-test`, `_EGC_MATRIX`) that no longer exists.

**Pipeline**
- `EGC_KEGG_TREE.ipynb` cell 5 / `migrate_annotations_to_sql.py:89-90`: the stored single `parent`/`category` of a KO is its *last* BRITE occurrence. On today's file 18,626 of 28,571 KOs get category "Brite Hierarchies", 3,803 "Not Included", and 8,725 KOs that are in a real pathway are stored under a BRITE table (K00844 → `04131 Membrane trafficking`). The UI now reads `/kegg/parents` (W30), but the fallback path (`ExplorePage.tsx:731`, `AnnotationInfoDrawer.tsx:101`) and the raw API fields still expose it. Prefer the first pathway-class occurrence.
- Silent skips: `Build_KEGG_DB.ipynb` cell 3 `if len(info) < 3: continue`; `All_Coverages.py:21,25` skips lines not starting with `G`; `mappings.ipynb` cell 2 returns `{}` for a missing raw file; `migrate_annotations_to_sql.py:111-115` loads every `*.<suffix>` file with no check against the 128-sample list; `migrate_mappings_to_sql.py:237` `taxon_lookup.get(...)` → NULL with no count; `verify_annotations_migration_against_json.py:99-104` compares only `egc`/`norm_egc`. None fires today; each would make a number quietly wrong rather than stop the build.
- `EGC_*_TREE` notebooks use `covs.get(scaff, 0)` while `weighted_totals.py:128` raises `KeyError`: a scaffold with no depth row would contribute 0 to EGC but still count in `gene_count`/`scaffold_count`. Today the denominator aborts first.
- `ko00001.keg` has no provenance sidecar (the EC file has one), so "KEGG release dated 22 May 2026" cannot be checked from the repo. `KEGG_preDatabase.ipynb` still carries the superseded single-parent `parse_brite`.

**Charts**
- `useAllSamples.ts:46-64`, `useSolarTideData.ts:52-78`: a failed `/api/samples` (or tides, sun-times) fetch is never retried for the session; every chart afterwards draws across non-detections with the amber warning. Clear `promise` in `.catch`.
- `MultiEgcChart.tsx:116-125`: a series row without a timepoint becomes `_ts = 0` (1970) instead of being skipped as the other two charts do. Cannot occur today (startup assertion).
- `signal.ts:103`: a 4-point LOWESS floor the Methods page does not mention.
- `ChartControls.tsx:103,116`, `stats.ts:30`, `AnalyzePage.tsx:447-451`: tooltips/comments define relative abundance as "EGC ÷ total sample sequencing depth"; it is the gene-weighted depth over *annotated* scaffolds.
- `chartCsv.ts`: `date` is the raw PDT string with no zone; grouped CSV lacks `sample` and `members_detected`; `tide_predicted_wl_m` is the nearest 6-min reading within 30 min, unstated.
- `ExplorePage.tsx:1016-1028` → `stats.ts:294-304`: "Trend Δ EGC" quarters are quarters of the detected points, not of the time span.

**Pages and panels**
- `utils/taxonomy.ts:98-104,112`: the "remove" line subtracts `norm_egc` without clamping; live residual for Archaea minus all 9 phyla is −1.4e−17…+2.8e−17, which the hover formats as "-1.39e-15%". EGC residual is exactly 0 in all 128 samples. `Math.max(0, …)`.
- `constants.ts:107,120,124`: COG category names D, Q, U differ in wording from what `/api/cog/children` serves ("cell division", "and catabolism", "and vesicular transport").
- `AboutPage.tsx:62-66` lists five Explore views; there are six (Bulk Download).
- `AnalyzePage.tsx:878-918`, `LeftResultList.tsx:231,241`: "∑ Group" removes same-source containment only; sibling pathways sharing KOs, or a KO + COG + EC of the same genes, are summed with no caveat.
- `LeftResultList.tsx:36,349,354-357`, `MappingsPanel.tsx:167`, `ExplorePage.tsx:2106,2297`: hard-coded 128 although `useAllSamples` supplies the real count.
- `BulkDownloadPanel.tsx:451`: "716 KOs × 128 samples ≈ 128,512 rows" does not multiply (`max_rows` is blocks × samples with one block per path; live 716 × 128 = 91,648).
- `ExplorePage.tsx:2277`: Lookup tooltip says "Mean norm EGC = Mean EGC / total sample depth"; the value is `AVG(norm_egc)` over detected samples, a mean of ratios.
- `ExplorePage.tsx:2301-2312` with `cache_sql.py:924-931`: "Scaffolds (sample)" is the count from an arbitrary sample (unordered `LIMIT 1`); live psbA shows 16, per-sample counts range 11–17.
- `constants.ts:604-609`: `expandParentLabel('1.1.1','enzyme')` → "1.1.1 · Oxidoreductases"; every enzyme group under class 1 is headed by the class name.
- `ExplorePage.tsx:1017-1028, 770`: By Parent "Trend Δ EGC" is "—" for members after the first 20 (chart cap), indistinguishable from "too few points"; the banner mentions only the chart.
- `ScaffoldExplorePanel.tsx:41,472`, `ScaffoldModal.tsx:450-455`, `GroupScaffoldModal.tsx:611-616`: scaffold charts draw a line straight across samples with no scaffolds while the CSV writes 0 for them; EGC charts break the line at non-detection.
- Wording: `ExplorePage.tsx:402,432,585` "functional groups" for taxonomy/enzyme; `:1639,2010`, `ScaffoldExplorePanel.tsx:579` rank tooltips say "taxonomic rank(s)" for kegg/cog/enzyme; `:413-418` "Mean EGC distribution · kegg" is the top-200 distribution; `ScaffoldModal.tsx:308-321` shows a 404 (no scaffold rows) as "Failed to load … may have timed out"; `AnnotationInfoDrawer.tsx:94-101` shows the single stored parent until `/kegg/path` resolves, then swaps, and hides the Parent row when the stored parent is null even if real parents exist.
- `ComparePage.tsx:130` / `App.tsx:118-120`: the "not added" handoff notice survives Clear Page.
- `tests/test_frontend_page_size_contract.py` scans only `page_size=`; the Top EGC `limit` (NumberField max 200) vs route `le=200` is not pinned.

---

## 4. Performance

### X1. Correlation finder: a measured cause and a validated 18–24× redesign

**In plain terms:** the first search for a given reference is slow because the server scores the roughly 13,000 candidates one at a time in Python, with about 50 small library calls and one disk flush per candidate; on the production disk it also reads each candidate's values with a separate query. Loading all candidates into one array and scoring them together with numpy, then writing the cache in one transaction, gives identical results and is 18 to 24 times faster on a synthetic copy of the data. Until it is implemented, users wait a minute or more on a cold search and the proxy can time out.

This is the slowness the user reported. All numbers are from a synthetic on-disk SQLite db built with the real schema and indexes (`artifacts/correlation-perf/build_bench_db.py`: 32,000 catalog rows, 3.14 M `annotation_series` rows, 128 samples, AR(1) log-normal values, 15–25% missing, 10% sparse rows), run through the real app code by pointing `correlation_sql.SQLITE_DB_PATH` at it. Machine: i9-14900K, NVMe, warm page cache. **Production I/O is not reproduced**: the code's own comment records `load_vector` at ~75 ms live vs 0.06 ms here, so the live cold path is slower than these numbers by roughly 13,000 × 75 ms ≈ 16 min of random reads on top of the CPU time below.

**Where the time goes (measured, current code).** Cold 13,000-candidate kegg family through `correlation_family_endpoint`: raw_pearson 54.2 s, log_pearson 54.4 s, spearman 72.9–95.7 s. Warm (all cached): 0.07 s. Per candidate:

| component | ms per candidate |
|---|---|
| `load_vector` (one SELECT + Python loop) | 0.06 local; ~75 live |
| `_transformed_pair` ×14 (Python filter loop) | 0.06 |
| `stats.rankdata` ×26 (spearman only) | 0.89 |
| `stats.pearsonr` ×13 (115 µs each, ~80% wrapper overhead) | 1.50 |
| `_effective_n` ×13 (`np.correlate` ×26) | 0.13 |
| `stats.t.sf` ×13 | 0.25 |
| `_lag_tests_m_eff` ×1 (repeats the lag-0 transform and ACFs) | 0.51 |
| `score_pair` total | 3.0 (raw/log) / 4.6 (spearman) |
| per-candidate `INSERT` + `commit` (one WAL fsync, `synchronous=FULL`) | 0.84 |

cProfile over 400 spearman candidates: `score_pair` 76% (pearsonr 31%, transform + rankdata 27%, m_eff 9%, t.sf 6%, effective_n 4%), `commit` 22%, `load_vector` 2%. The family is bound by ~700,000 scipy calls and 13,000 fsyncs per family; production adds ~1.7 M random row reads. Commit patterns measured on 2,000 rows: per-row commit at FULL 0.839 ms/row; per-row at NORMAL 0.018; `executemany` + one commit 0.003.

**Design** (new module `FastAPI/api/correlation_vector.py` or additions to `correlation_sql.py`; the prototype is `artifacts/correlation-perf/fast_corr.py`):

1. `load_family_matrix(conn, source, metric, annotation_ids, sample_order)` → `(m × 128)` float array, NaN for missing/NULL. One query per chunk of ≤ 900 ids (`annotation_id IN (...)` against `idx_annotation_series_source_annotation_id`), cursor streamed (0.86 s for 13,000 kegg ids locally; `fetchall` of a whole-source query costs +250 MB RSS, streaming +13 MB).
2. `score_family(ref_vec, matrix, method)`: per lag, build the co-observed mask (`isfinite & > 0`), require k ≥ 10, transform (identity / one `np.log` / row-wise NaN-aware average ranks, exact against `rankdata`), Pearson with scipy's own formula (centre, scale by max |x|, dot, clip, NaN on constant rows), effective N on gap-compacted rows (`argsort(~mask, stable)` + `take_along_axis`, 25 `einsum` autocovariances, weights zeroed beyond each row's `k // 5`), one `t.sf` call per lag column, best lag by strict `>` in `CORRELATION_LAGS` order (so ties resolve exactly as today), m_eff from the lag-0 ACFs with a batched `(m, 13, 13)` `eigvalsh`. Chunk candidates at ~4,096 rows to cap temporaries (peak 118–187 MB for 13,000 rows unchunked).
3. `score_family_hybrid`: rows flagged as near a discontinuity (|r| within 1e−12 of 1; two lags' |r| within 1e−9 of each other; an eigenvalue within 1e−9 of an integer ≥ 2; `c0` within 1e−9 of 0; `df` within 1e−9 of 1) are recomputed with the scalar `score_pair`, so every discontinuous decision is taken by the reference code. Trigger rate 0–12 per 13,000.
4. `fetch_cached_family(conn, ref_id, metric, method)`: one query `WHERE (catalog_id_a = ? OR catalog_id_b = ?) AND metric = ? AND method = ?` (MULTI-INDEX OR over the UNIQUE index and `idx_correlations_cache_catalog_id_b`; 9.5 ms for 13,000 rows vs 45 ms for point lookups), lag negated when the reference is `catalog_id_b`.
5. `write_cache_rows`: `executemany("INSERT OR IGNORE …")` + one commit, inside the existing best-effort `OperationalError` handling. Canonical (low, high) with the lag negated when the reference is the high id (`score_pair` is symmetric under swap: r bit-identical, lag negated, p within 8e−15, checked on 2,500 pairs). **Filter non-finite r/p first** (NaN binds as NULL and `OR IGNORE` would silently drop the row). Write a sentinel row (`r=0.0, p=1.0, lag=0, n_pairs=0`) for every candidate `score_pair` returns None for, and have every reader drop `n_pairs = 0`; otherwise each warm request reloads the matrix for the never-cached sparse candidates.
6. Endpoint flow: validate → ref id → candidates → family lock → `fetch_cached_family` → missing set → if any: sample order, ref vector, matrix for the missing ids, `score_family_hybrid`, `write_cache_rows`, merge → FDR → sort → limit. `_get_or_compute_correlation` stays for `/correlation` but must treat sentinel rows as None.
7. `_connect()`: `PRAGMA synchronous = NORMAL` (WAL keeps consistency; the cache is recomputable).
8. `create_sql_indexes.py`: consider a covering index `annotation_series(source, annotation_id, sample, egc, norm_egc)` so the production load is one sequential index read per source instead of 1.7 M random row reads (+~380 MB on the live 7.06 M-row table; estimated, not measured; measure the live `WHERE source='kegg'` load before and after and skip if already fast).
9. Do open item N3 (cache versioning or clear at deploy) in the same change so a family never mixes scalar- and vector-written rows.

**Validation (reproduced by the coordinator).** `artifacts/correlation-perf/validate_fast.py` compares `score_family` with `score_pair` on 2,520 candidates (2,500 random including sparse ones, plus 20 constructed edge cases: identical/shifted/negated reference, constant, constant-but-one, exactly 10 and 9 co-observed, ties, periodic, trend, alternating/half/top-half missing, zeros for NaN, complement support, 12-point linear/quadratic). Result for all three methods: 0 mismatches; the 3 None cases reproduced; max |Δr| 5.6e−16, max |Δp| 4.2e−15; lag and n_pairs exact; 8–12 rows guarded and exact after fallback. `validate_full_cache.py` ran the real endpoint cold for all three methods and compared all 13,000 cached rows: 0 mismatches, top-500 order after FDR identical, `significant_count` identical. One discontinuity found: perfectly correlated candidates give scalar r = 1.0 exactly (p = 0) and vector r = 0.9999999999999998 (p ≈ 8e−308); hence the |r| ≈ 1 guard.

**Timings (synthetic, local):**

| family (cold) | current endpoint | proposed | load / score / write |
|---|---|---|---|
| kegg 13,000, raw_pearson | 54.2 s | 2.3 s | 1.05 / 1.2 / 0.03 s |
| kegg 13,000, log_pearson | 54.4 s | 2.7 s | 1.05 / 1.2 / 0.37 s |
| kegg 13,000, spearman | 72.9–95.7 s | 4.0 s | 1.08 / 2.9 / 0.03 s |
| kegg→kegg 12,935 (same-source exclusions), spearman | ~81 s (extrapolated) | 3.7 s | 0.86 / 2.84 s |
| cog 5,000, spearman | ~32 s | 1.4 s | 0.33 / 1.04 s |
| enzyme 4,000, spearman | ~25 s | 1.4 s | 0.54 / 0.83 s |
| taxonomy 7,500, spearman | ~47 s | 2.2 s | 0.62 / 1.60 s |

Scoring alone: 0.107 ms (Pearson) / 0.261 ms (Spearman) per candidate vs 3.0 / 4.6 ms (28× / 18×). A less invasive option, keeping the per-candidate loop but using numpy masks, direct Pearson, batched `t.sf` and ACF reuse (`lean_scalar.py`), measures 0.77 / 1.89 ms per candidate: 4–6× better than today, 5–8× slower than vectorised.

**Risks.** Not bit-for-bit (row-wise reductions on padded arrays vs BLAS `ddot` on compacted pairs); tolerances above. `score_pair` must remain the reference and the equality test must stay in the suite. Old and new cached rows differ in the last digits, so the cache must be cleared or versioned (N3). Sentinel rows change cache semantics; all readers must filter `n_pairs = 0`. `INSERT OR IGNORE` hides NOT NULL violations, so the non-finite filter is load-bearing. The per-family lock remains useful (waiters now wait seconds). With a cold family at ~5 s locally (allow 3× on the production host plus the load), the 60 s nginx cut-off (N1) should not be reached for any source; keep the client retry as a safety net.

**Tests to add** (`tests/test_correlation_vectorised.py`, fixture pattern from `tests/test_correlation_tier1_cache.py`): `score_family` vs `score_pair` on a seeded 500 × 128 matrix with missingness, sparse/constant rows, copies and shifted copies of the reference, ties (r atol 1e−12, p rtol 1e−9, exact on guarded rows, lag/n_pairs exact, None ↔ ok=False, all three methods); `rank_rows_nan` vs `stats.rankdata` exact; `load_family_matrix` vs `load_vector`; the endpoint cold writes real + sentinel rows and a second request loads and scores nothing (monkeypatch); lag sign when the reference has the higher id (closes T2/CR1); sentinels excluded from results and `tested_count`; `INSERT OR IGNORE` race (reuse `RacingConnProxy`) and NaN filtering.

### X2. Date-filtered `/annotations/top` scans the whole source partition (54 s live)

**In plain terms:** setting a date range on the Dataset Overview or Top EGC views makes the server read every row for that source, about 5 million for taxonomy, to find the ones in range. That took 54 seconds live, close to the 60-second proxy timeout. The fix is to make the query use the per-sample index that already exists.

**Where:** `FastAPI/api/cache_sql.py:807-823` (`WHERE source = ? AND sample IN (...) GROUP BY annotation_id`).

**What:** the planner uses `idx_annotation_series_source_annotation_id (source=?)` and walks every row of the source (taxonomy ≈ 5 M of 7 M rows) to test `sample IN (...)`. Live: `source=taxonomy&limit=5&date_from=2021-06-02&date_to=2021-06-04` (18 samples) took **54.1 s**, within sight of the 60 s nginx timeout; the result is cached for 30 min per exact range. Dataset Overview and Top EGC Annotations both issue this request whenever a date range is set.

**Better plan:** the `UNIQUE(source, sample, annotation_id)` autoindex supports `(source=?, sample=?)` seeks and each sample's rows are contiguous (the migration inserts per source per sample). On a 1.2 M-row fixture, `EXPLAIN` shows `SEARCH … (source=?)` as written and `SEARCH … (source=? AND sample=?)` with `INDEXED BY sqlite_autoindex_annotation_series_1`; `ANALYZE` alone did not change the plan. Rewrite with a row-value predicate `(source, sample) IN (VALUES (?,?), …)`, or aggregate per sample in Python (≤ 128 indexed queries), or add an explicit `(source, sample)` index. Expected: work proportional to the samples in range instead of the whole partition; seconds rather than a minute on the production disk. Script: `artifacts/api/plan_timing.py`.

### X3. First `get_all_sample_names_sql` after a restart is a full scan of the 74 M-entry mappings index

**In plain terms:** the first request after the server restarts scans the entire 74-million-entry gene index just to list the 128 sample names. That can take minutes, and every request arriving in that window repeats it.

**Where:** `FastAPI/api/cache_sql.py:106` (`SELECT DISTINCT sample FROM mappings ORDER BY sample`), cached per process with no lock.

**What:** plan is `SCAN mappings USING COVERING INDEX idx_mappings_sample_gene`: every index entry is visited to produce 128 values. It runs on the first `/timepoints` (the app's online ping), `/samples`, `/mappings/search`, `/annotations/top` or `/series/export` after each restart, concurrently if several arrive at once. Not measurable live (process warm); `create_sql_indexes.py` records 143 s for a similar DISTINCT over the smaller `annotation_series` before it was indexed.

**Better plan:** a loose index scan (`WITH RECURSIVE s(x) AS (SELECT MIN(sample) FROM mappings UNION ALL SELECT (SELECT MIN(sample) FROM mappings WHERE sample > x) FROM s WHERE x IS NOT NULL) SELECT x FROM s WHERE x IS NOT NULL`, 128 seeks; plan verified), or reuse `load_sample_order`'s indexed `SELECT DISTINCT sample FROM annotation_series` and compute once in `lifespan`.

### X4. Minor
- `cache_sql.py:848-856`: `get_top_annotations_from_catalog_sql` returns the whole per-source catalog (≈ 68,800 taxonomy rows) to keep 200; add `LIMIT`.
- `/search/annotations` fetches every match (two correlated subqueries per row) and sorts/paginates in Python: 0.86 s for the 6,119 "protein" matches; `ORDER BY … LIMIT/OFFSET` in SQL would cut it.

---

## 5. Checked and found correct

So that the next reviewer does not redo this. Each was verified by reading and, where stated, numerically.

**Pipeline.** EGC = Σ over scaffolds (distinct genes with the annotation on that scaffold × AvgFold) per sample in all four notebooks; scaffold id from `gene_id.rsplit('_', 2)[0]`; genes deduplicated per (node, sample) (synthetic run: duplicate KO rows and multi-domain COG rows count once). norm_egc denominator = Σ over the union of all annotated genes (each once) of count × AvgFold from the same depth table; every numerator is a subset, so norm_egc ∈ [0, 1] and the denominator is shared by all four sources. Roll-up: a gene with two KOs under one pathway counts once in the pathway and its ancestors; K00844 reached under all 14 parents; COG leaf once and every category once; EC walk once per node; `gene_count`/`scaffold_count` from the same dict as EGC. EC: all 19 `TRANSFERRED_EC` entries and `3.6.3.- → 7` match KEGG ENZYME today; `resolve_or_drop_ec` order matches the Methods text; `ko01000.keg` parses to 7,334 nodes with 0 regex failures. Taxonomy keyed by lineage prefix, `normalize_lineage` shared, depth = position, parent = prefix, identical consecutive names kept as distinct ranks. Catalog mean/max over detected samples only, `sample_count` = detections. Migrations use plain INSERT under UNIQUE; `kegg_paths` row count equals the notebook's occurrence count per KO; `cog_paths` keeps 400 multi-category COGs. Dropped annotations: 33 KOs / 19 COGs absent from the references, 0 ECs (`docs/MISSING_ANNOTATIONS.md`).

**API.** Taxonomy remove/keep arithmetic is done client-side from `/series/annotations` on the scope's sample axis, a branch absent in a sample contributes 0, nested checks are filtered before summing, and taxonomy EGC is a strict roll-up, so both subtractions are exact (live: Archaea EGC equals Σ of its 9 phyla in all 128 samples). Sunrise/sunset: Almanac-for-Computers implementation agrees with an independent NOAA-spreadsheet computation within 0.64 min on all 23 dates; the fixed −7 h is correct for the window. Tides: after the +1 h shift the live series equals NOAA's predictions in local daylight time to 0.000 m at all 240 six-minute points on 2021-06-03 (0.36 m off without the shift); tides and sun-times are on the same PDT clock. `/status` date range equals the real sample min/max; `/timepoints` filters the 4 never-processed CSV rows. `/series/annotations`: one row per detected sample, chronological, prefixes accepted. `/series/export`: chronological ISO dates, undetected samples written as `0,0,false` (dense) or omitted (sparse) with the `detected` column and summary flag saying which, chunked id order preserved, lineage columns correct. `/annotations/top` both paths average over detected samples; bare-date bounds inclusive whole days. Hierarchy endpoints: roots DISTINCT and sorted, multi-parent nodes get one path per real lineage, bulk parents resolve from the deepest level. `/mappings/search`: DISTINCT mapping ids, sample cap and truncation flags returned and shown for the on-screen table, unique-pairs keeps the earliest occurrence. `/search/annotations`: substring, case-insensitive, LIKE metacharacters escaped, totals always complete. All routes sync `def` in the threadpool with short-lived connections; WAL.

**Correlation finder.** Lag sign end to end: for lag > 0 `ref[t+lag]` pairs with `cand[t]`, so the candidate leads; a candidate peaking 2 samples earlier gives `best_lag = +2`; the cache stores relative to the low id and negates for a high-id reference (fresh-compute high-id path returns −2 and stores (1, 2, +2), closing the T2/CR1 gap in practice); the panel's "leads by"/"lags by" and tooltips match; 300 role-swapped pairs: r, p, n identical, lag negated. Effective N: formula as on the Methods page, computed on the transformed co-observed values of the chosen lag, capped at N, p = 1 when df < 1; dropping non-detected timepoints does not bias it beyond F10. `_lag_tests_m_eff`: `cross(shift)` = Σ_h acf_x(h) acf_y(h + shift), symmetric, diagonal 1; `abs()` of eigenvalues is the Li & Ji definition; measured m_eff: white noise 12.65, φ 0.85 3.9, shared trend 2.15, matching "close to 13 / about 4 / about 2"; N_eff median 30.0 matches "about 30". Selecting by max |r| rather than min p is immaterial (rates equal to three decimals). Family exclusions pass 12 constructed fixtures (depth-1 refs, multi-parent KOs, cousins kept, enzyme NULL-parent roots, taxonomy `';'` guard, COG multi-category, cross-source no exclusions, species/strain refs below the cutoff); `kegg_paths` is filtered to real catalog ids at migration so the "depth None" fallback cannot trigger by id-format mismatch. Cache: canonical key, both orderings hit one row, IntegrityError re-read negates correctly, column positions match the schema. FDR over every scored candidate before truncation, `significant = q < 0.05`, counts pre-limit. Methods page numeric claims that can be checked without the database all hold (13 lags, 4 h, limit 50/500, 10-point floor, N/5, "N_eff never exceeds N", rank ties averaged).

**Charts.** `parseMMDDYY` handles `M/D/YY[ H:MM]`, 24-hour, unpadded; points and night bands go to Plotly as naive local strings, never epoch numbers, so every viewer sees PDT wall-clock (135 strings × 12 IANA zones: 0 mismatches; no zone has a DST transition in the window). Missing detections are explicit nulls with `connectgaps: false` in all three charts, never 0 or interpolated; stats and Z skip nulls; "N of 128 (detected in M)" counts match the markers. Sums: per-datetime over detected members, null only when no member is detected; norm_egc summed (valid); nested members dropped before summing on Analyze and Taxonomy. Z-score population σ confirmed numerically; LOWESS window, weights, local-linear fit on real time, nulls kept, straight line through a 12 h gap reproduced to 4e−12; `computeStats` matches numpy for mean, median, `std(ddof=1)`, Type-7 percentiles, CV. Day/night bands from the day before the first sample, clipped to the data span, edges verified. Tide trace native 6-min in metres, no second shift. CSV value column named after the metric with `metric`/`standardized`/`smoothed` per row. Labels cover all metric × Z combinations; colours shared by trace and legend; no log axes. No path where a chart shows a previous selection's data (caches keyed by `annotation::source`, sequence refs in Explore, single in-flight promise in shared hooks).

**Pages.** Analyze: cache keyed `${id}::${source}`, metric switch reuses rows, search `page_size=5000` matches the backend cap with truncation shown, nested group members dropped with an alert, header mean shows "n / total samples", list tooltip says "Mean when detected". Compare: rows keyed by datetime, nulls as gaps, Z per series over its visible non-null points, cap of 4 in both add paths. Hierarchy utilities: taxonomy containment is `startsWith(other + ';')` (pinned by tests), KEGG/COG via all paths, enzyme ids bare, rank/depth labels per source match the backend, `AnnotationInfoDrawer` lists every real immediate parent. Correlates panel: every attempt clears rows, late responses discarded by sequence, retries only on abort/5xx, counts shown as "S of T significant (q<0.05, BH-corrected)", q labelled BH FDR, per-card so results never belong to another annotation. Explore: Overview per-timestamp member sums under `loadedParams`, 40-member cap disclosed; Top EGC `mean_egc` = AVG over detected samples, `#` is the position in the current sort, truncation disclosed; By Parent multi-parent rows under every real parent (noted), 20-member chart cap disclosed; Lookup parents from all `/kegg/path` paths; scaffold panels never recompute EGC client-side, dates re-emitted as local time, nested members dropped by real paths; Mappings sample cap reflected in field, banner and empty state; Bulk Download columns match `_EXPORT_HEADER`, dates `YYYY-MM-DD HH:MM`, only the requested level (+ optional start block), path choices keyed on (term, immediate parent) on both sides; external links: bare `K#####`, pathway/BRITE branching on name markers, COG URLs current, full EC → KEGG + ExPASy, NCBI taxonomy is a labelled name search. Number formatting: EGC `toExponential(2)` in tables, relative abundance a fraction on the Lookup card and a percent in chart tooltips, each labelled.

---

## 6. Still open from `docs/AUDIT-2026-11-03.md`

Not re-described; listed so a fresh agent has one place to look. **E6/E14** KEGG notebook cells never run or saved, absolute paths. **N1** uncached family requests get a 504 from nginx (X1 should make this moot; keep the retry). **N2** `MISSING_ANNOTATIONS.md` cites an untracked file. **E16** two lineage parsers disagree on empty segments. **CR2** ~6% per-pair rate (root cause now identified: F10). **N3** cache not invalidated on a method change (must be done with X1 and F10). **N4** cross-source and compositional caveats missing from the Methods page. **W21** "Mean EGC" headers do not say "when detected". **W22** Scaffold Information opens aggregated. **N5** stale labels and comments. **T2** tests that would not catch W14/W16/CR1 (CR1's fresh-compute high-id path was exercised in this audit and is correct; still untested). **T3** frontend suite fails under `TZ=Asia/Tokyo`. **N6** KEGG BRITE licensing.

---

## 7. Could not verify without the database or raw data

- Scaffold and gene counts against the JGI files (`test_scaffold_ground_truth.py`, `test_egc_api_vs_jgi.py` need `Metagenome_Samples/`, `KEGG/`, `COG_genes/`); `conftest.py` claims 0 EGC mismatches vs JGI across 128 samples.
- The `.a.depth.txt` column layout, and whether any gene has more than one KO row in `.a.ko.txt` (the schema docstring says at most one; `Build_KEGG_DB`'s docstring says the opposite; if so `mappings.kegg_id` would hold `KO:K1,KO:K2` and the exact `IN` match in `cache_sql` would miss it in the Mappings panel).
- That `annotation_series.category`/`parent`/`depth` are constant per `(source, annotation_id)` on the live table (the code relies on it with `MIN()` and unordered `LIMIT 1`).
- The real gap positions in `JGI_ID_Timepoints_128.csv` (F8's error distribution), that the CSV is in PDT (only the tide cross-reference supports it), and the Methods page's "median 29, middle half 23–37" and urease/psbA/RuBisCO examples.
- Production disk behaviour for X1 and X2 (local numbers are warm-cache NVMe), the production SQLite version and `ANALYZE` state.
- Whether a bulk download failing mid-stream is reported as failed (`StreamingResponse` without `Content-Length`; no row count or terminator in the file).
- `/series/export/review` was checked only for kegg 09101/ko.
- Plotly's rendering itself (jsdom, no canvas).

---

## 8. Checklist

- [x] **F1** Export-all mappings CSV complete or refused with a message; "every row" text conditional on the real total (05867d3: streams every record)
- [x] **F2** `KO:`/`EC:` prefixes accepted by `/search/annotations` (`q` and `annotation_id`); route tests (8e8b065)
- [x] **F3** exact id ranked first; Lookup auto-selects an exact id; page size or load-more (0668f1b)
- [x] **F4** Analyze handoff uses an exact-id request; handoff test pinned (5822ec2)
- [x] **F5** KEGG sibling exclusion limited to pathway parents; BRITE tables labelled; Methods page updated; test with a BRITE-only KO (a8d6800, 9a87217)
- [x] **F6** group totals show the category's own mean; member Σ labelled as overlapping and partial (c20044d)
- [x] **F7** Z-score window stated (or computed over the full series); CSV records the window (62b177b: computed over the full series)
- [x] **F8** lag hours stated as nominal, or computed on the real time axis (236cb36: stated as nominal)
- [x] **F9** lag shown only for significant rows or flagged at the window edge (8db3371: faded when not significant, edge marked 24h+)
- [x] **F10** `N/(N−j)` ACF estimator; simulation bar at 6%; Methods "about half" corrected; cache cleared/versioned (N3) — estimator kept and the measured rate stated on the Methods page instead, Michael's choice (ef5b5b6); cache versioned (d32f061)
- [x] **F11** `/annotations/top` takes a depth; Top EGC sends the rank (f21aa5c)
- [x] **F12** sequence guards in Scaffold Information and Bulk Download search; `r.source` used (756b74f)
- [x] **F13** Compare: no duplicates via select-all, no colour reset on handoff, groups keyed by member set, skipped groups reported (83d7ca2)
- [x] **F14** homonym hints append the rank when they collide (c738943)
- [x] **F15** partial-EC external link goes to a real page (523e34d)
- [x] **F16** Mappings panel shows gene and scaffold; "N genes" (0cf26ac)
- [x] **F17** `include_parent` with an undetected parent → 404 (84d6637)
- [x] **F18** untested-candidate count returned and shown; Methods sentence softened (3e8b7b4)
- [x] **Low items** of section 3 triaged — all six groups done (through 5323455 and 8629009)
- [x] **X1** vectorised family scoring with equality test against `score_pair`; batched cache writes; sentinel rows; `synchronous=NORMAL`; cold kegg family under 10 s locally — 76f12aa, d32f061, cd7dad6; unscorable pairs go in a separate correlations_unscored table instead of sentinel rows; plus the covering index idx_annotation_series_family_values (4c53c08), which the live server needed: cold psbA vs kegg 5.6 s locally, cold taxonomy family 4.6 s live
- [x] **X2** date-filtered `/annotations/top` uses `(source, sample)` seeks; live taxonomy 3-day range under 5 s — 9fa358d, not via (source, sample) seeks: measured live, those were slower (48 s vs 19.6 s); instead the numbers come from the covering index and name/parent/depth from annotation_catalog. Live 3-day taxonomy range 14 s (was 36-69 s), not under 5 s
- ❌ **X3** sample names via loose index scan or `annotation_series`, computed at startup — not needed: SQLite 3.46 (live) and 3.50 already skip ahead through the index for this DISTINCT (SeekGT in the bytecode, despite the plan's "SCAN"); 128 names in 0.04 s live, whole startup 5 s, and it already runs once at startup since 10e875c
- [ ] **X4** catalog top `LIMIT`; search ordering in SQL

---

## 9. Artifacts

`docs/audit-2026-11-03-artifacts/` (untracked; `docs/AUDIT*.md` is gitignored, so this document must be force-added if it is to be committed, as the previous one was).

- `reports/findings-*.md`: the seven reviewers' full reports (pipeline, api, correlation-math, correlation-perf, frontend-charts, frontend-pages-a, frontend-pages-b), each with its own "checked and found correct" list and verification notes.
- `correlation-perf/`: `fast_corr.py` (the vectorised prototype: `score_family`, `score_family_hybrid`, `rank_rows_nan`), `lean_scalar.py` (the less invasive option), `validate_fast.py` / `validate_detail.py` / `validate_full_cache.py` (equality tests against `score_pair` and against the real endpoint's cache), `build_bench_db.py` (rebuilds the 540 MB synthetic db as `bench.db` in that folder; not copied), `bench_*.py` and `profile_fast.py` (timings). Run from that folder with `../../.venv/bin/python`.
- `correlation-math/`: `sim_null.py` (the rate table in F10; `-m slow`-class runtime, writes `sim_null.json`), `sim_followup.py` (F9 lag pile-up and power), `sim_fdr.py` (family-wise), `sim_small_n.py`, `meff_small_n.py`, `check_family.py` (12 exclusion fixtures), `check_lag.py` (lag sign end to end), `gap_arith.py` (F8), plus the saved `sim_null.json` / `sim_null.log`.
- `pipeline/`: `kegg_sibling_experiment.py` (F5 counts; takes the path to a `ko00001.keg` as its argument; the KEGG file itself is not included), `brite_experiment.py` and both `.out` files.
- `api/`: `probe_fixture.py` (PROBE1 F1, PROBE2 F17, PROBE4/5 the cache-key and off-by-one Lows), `plan_probe.py` / `plan_timing.py` (X2 query plans), `suncheck.py` (independent sunrise/sunset).
- `frontend/`: `audit-app-handoff.test.tsx` (F4), `audit-compare.test.tsx` (F13 and the Clear Page Low; copy into `frontend/src/tests/` to run, Vitest refuses files outside its root), `check_rollup.py` (live Archaea roll-up check), `solar_check.py`.

The Python scripts resolve `FastAPI/` relative to their own location; the frontend probes need Node 24 on `PATH`.
