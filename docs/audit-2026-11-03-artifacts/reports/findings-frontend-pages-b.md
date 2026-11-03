# Audit: Explore page and per-annotation detail panels (frontend-pages-b)

Branch `feature/sqlite-integration`, HEAD `a993ead`, 2026-11-03. Read-only review; one temporary vitest probe was written, run and deleted. Known items W21, W22, N5 are not repeated.

Live requests used (all GET, read-only): `/annotations/top` (kegg, taxonomy; limit 2 and 200), `/kegg/parents` (one batch), `/annotations/scaffolds/summary` (K02703), `/search/annotations` (7 queries), `/mappings/search` (K02703, 1 sample, 2 rows), `/series/export/summary` and `/series/export/review` (kegg 09101 / ko), `/kegg/path` (K00134). Two external GET requests to genome.jp and enzyme.expasy.org to check link targets.

---

### [H] Annotation Lookup: an exact EC number is neither returned alone, nor auto-selected, nor guaranteed to be in the 25 rows shown

**Where:** `frontend/src/pages/ExplorePage.tsx:1349` (`page_size=25`), `:1356` (auto-select only when `results.length === 1`), `:1900` ("exact IDs return one result; general terms return a ranked list"). Backend: `FastAPI/api/routes.py:464-516` (`q` of 3+ characters is a substring `LIKE` on id or name, results sorted by `mean_egc` only; `FastAPI/api/cache_sql.py:874-968`).

**What is wrong:** An EC number is a substring of every longer EC number that starts with it, so "1.1.1.1" matches 1.1.1.100, 1.1.1.193, ...; the exact id is just one of them, ranked by mean EGC. Nothing in the route or the page promotes or detects an exact match, and the page fetches only 25 rows.

**User-visible effect (confirmed live):** enzyme `q=2.7.1.1` (hexokinase) -> `total: 62`, the exact id is at position 43 -> the Lookup card shows "62 results · showing 25" and 2.7.1.1 is not among them; the user cannot open it at all from this card. `q=1.1.1.2` -> 41 results, exact at 15; `q=1.1.1.1` -> 42 results, exact at 3 (visible, but not selected). The same applies to KEGG codes with a longer form (`q=00010` -> 00010 and K00010). The help text above the box says exact ids return one result. Related: ids written the way the Methods page prints them ("EC:1.1.1.1") or the mappings API accepts ("KO:K02703") return 0 results from this card (live: both `total: 0`), while `/series/annotations` and `/mappings/search` strip the prefix.

**How verified:** code read; live requests above.

**Suggested fix:** when the trimmed query looks like an id, call `/search/annotations?annotation_id=<id>` (the route already supports an exact `annotation_id` parameter) first and auto-select the hit, or have the backend sort exact id/name matches first; strip `KO:`/`EC:` on the client; raise `page_size` (route allows 5000) or show the total with a "load more".

---

### [M] Group "Σ Mean EGC" totals in Dataset Overview and Annotations by Parent exceed the category's own EGC for KEGG and are sums over a partial member set

**Where:** `ExplorePage.tsx:225-245` (Overview `parentGroups.sumEgc`), `:432` ("Top Functional Groups by Σ Mean EGC"), `:728-756` (By Parent `sumEgc`), `:850` and `:861` (tooltips: "useful for ranking which functional categories dominate the dataset"). Both panels load `/annotations/top?limit=200` and sum `mean_egc` of the members that happen to be in those 200 rows, filing a multi-parent row under every real parent.

**What is wrong:** (a) For KEGG/COG a pathway or KO that belongs to several subcategories is counted once per member, so Σ(member means) is larger than the category's own roll-up (which counts each gene once). (b) Σ covers only members among the top 200 rows. (c) The Overview shows both numbers for the same category -- the parent's own mean in "Top-level categories", the inflated Σ in the ranked list -- with nothing saying which is the category's size. The Overview tooltip explains nested-group overlap and the By Parent tooltip explains cross-group overlap; neither says a single group's Σ can exceed that group's own total or that it is a partial sum.

**User-visible effect (confirmed live, kegg):** the 200 rows are 8 A-level, 41 B-level, 150 C-level and 1 KO. "Metabolism" group Σ = 6.56e6 (11 subcategory members) vs Metabolism's own mean 4.22e6 (+55%); "Carbohydrate metabolism" Σ 1.58e6 vs own 9.85e5 (+61%); "Amino acid metabolism" (09105) +47%; "Brite Hierarchies" +11%. For taxonomy the top groups come out 0.94-1.00 of the parent's own mean, so the direction of error depends on source. The "∑ Summed by parent" table ranks categories by this statistic.

**How verified:** code read; live `/annotations/top?source=kegg&limit=200` + `/kegg/parents` and `source=taxonomy` recomputation (scratchpad `top_kegg.json`, `kegg_parents.json`, `top_tax.json`).

**Suggested fix:** show the parent's own `mean_egc` (it is in the same `/annotations/top` response for every group that is itself a row, and in the catalog otherwise) as the group total, and label the member Σ as "Σ of listed members (overlapping)"; or at least add to both tooltips that a group's Σ can exceed the category's own EGC and covers only the members shown.

---

### [M] Methods page says top-level categories are "shown separately on the Explore page"; the Top EGC Annotations table ranks them first

**Where:** `frontend/src/pages/MethodsPage.tsx:122-125` ("top-level categories ... are shown separately on the Explore page instead of being ranked next to the groups they already contain"); `ExplorePage.tsx:1744-1830` (Top EGC table ranks every row returned by `/annotations/top`; only the optional Rank pills narrow it).

**User-visible effect:** Load kegg in Top EGC Annotations: #1 "09180 Brite Hierarchies", #2 "09100 Metabolism", ... (live `limit=2`); with the default Top N = 25 every row is a class, subcategory or pathway; with 200 rows, one KO. The statement is true only for Dataset Overview and Annotations by Parent.

**How verified:** code read; live request.

**Suggested fix:** either qualify the Methods sentence (Overview and By Parent) or pre-select the leaf rank pill by default for kegg/cog/enzyme in Top EGC.

---

### [M] Scaffold Information: a search that resolves after the source dropdown was changed lands under the new source, and clicking a result adds the term with the wrong source

**Where:** `frontend/src/components/scaffolds/ScaffoldExplorePanel.tsx:309-324` (`runSearch`: no request-sequence guard), `:326-332` (`handleSourceChange` clears results but cannot cancel the in-flight response), `:623` (`addTerm(r.annotation_id, searchSrc)` uses the live dropdown, not `r.source`). Same pattern in `BulkDownloadPanel.tsx:252-266` (`search()`) with `pickSearchResult` using the live `source` (`:268`).

**User-visible effect:** search "Bacillus" in taxonomy, switch the dropdown to kegg while it is loading: the taxonomy results appear under kegg ("1 results -- click to add"; a no-match would read "No results found ... in kegg"); clicking adds a term tagged `kegg` whose id is the taxonomy lineage, which then reads "failed to load" (the summary endpoint 404s). Two quick searches (change the text, Enter twice) can likewise show the slower, older query's results. In Bulk Download the mismatched start makes the size request fail ("Could not work out the size of this download").

**How verified:** wrote and ran a vitest probe against the real component (deferred `/search/annotations` promise, change `<select>`, resolve, click): the summary request was `...source=kegg&annotation_id=Bacteria%3BFirmicutes...`. Probe deleted afterwards.

**Suggested fix:** the same `requestSeqRef` pattern the Explore page uses for its own lookups; add the term with `r.source ?? searchSrc`.

---

### [M] External link for an EC class/subclass/sub-subclass goes to an empty KEGG page

**Where:** `frontend/src/components/ui/ExternalLinks.tsx:153-163`: a partial EC id is padded to `ec:1.1.1.-` and linked to `https://www.genome.jp/entry/ec:1.1.1.-`. `frontend/src/tests/external-links.component.test.tsx:184` pins `ec:2.7.-.-`.

**User-visible effect:** the Lookup card (and the Analyze info drawer) for any of the enzyme tree's non-leaf nodes (classes, subclasses, sub-subclasses -- all catalog entries with EGC) offers exactly one link, and it opens a KEGG page titled "KEGG ENZYME: 1.1.1.-" whose body is "No such data". The ExPASy link is (correctly) suppressed for partial ids.

**How verified:** live GET of `https://www.genome.jp/entry/ec:1.1.1.-` (HTTP 200, body "No such data"); `https://enzyme.expasy.org/EC/1.1.1.-` returns 200.

**Suggested fix:** for partial ids link to the BRITE browser (`show_brite?htext=ko01000.keg&query=1.1.1`, the pattern already used for KEGG codes) and/or ExPASy's class page `https://enzyme.expasy.org/EC/1.1.1.-`.

---

### [M] Mappings panel never shows the gene or scaffold of a mapping row

**Where:** `frontend/src/components/mappings/MappingsPanel.tsx:380-405` (columns: Date, Time, Taxonomy, KEGG, Enzyme, COG) and `mappingsData.ts:85-105` (`buildMappingCsvRow` writes the same fields). The API row carries `gene_id` and `contig_id` (`types.ts` `MappingRow`; live: `"gene_id":"Ga0590984_0002077_2_1003","contig_id":"Ga0590984_0002077"`), and `get_mappings_sql` returns exactly one row per gene (`cache_sql.py:1360-1409`, `GROUP BY mappings.id`, several COGs/ECs on a gene are comma-joined in one row).

**User-visible effect:** "17 rows" for K02703 in one sample is 17 genes, but the user cannot see that, cannot tell two identical-looking rows apart, and the CSV cannot be joined to JGI files or to the scaffold panels. With "Unique pairs" on, rows are collapsed by (taxonomy, kegg, enzyme, cog) and the gene count is lost entirely without any count of how many were merged.

**How verified:** code read; live request. (Header comment `:17` also says "Pagination (100 rows per page)"; `MAPPINGS_PAGE_SIZE` is 25.)

**Suggested fix:** add Gene and Scaffold columns (at least to the CSV), and show "N genes" rather than "N rows".

---

### [L] Bulk Download size line: "716 KOs × 128 samples ≈ 128,512 rows" does not multiply

**Where:** `BulkDownloadPanel.tsx:451`; backend `routes.py:1113-1125` (`max_rows = blocks × samples`, where blocks counts one block per path, `taxa` counts distinct terms).

**Effect (live, kegg 09101 -> KO):** 716 × 128 = 91,648, but 128,512 is shown after "≈" because 194 KOs get one block per pathway. The explanation is only inferable from the separate "194 of these KOs are in more than one pathway" line.

**Fix:** show blocks ("1,004 term-paths") or say "× 128 samples, one block per pathway".

---

### [L] Lookup card tooltip states a wrong formula for "Mean norm EGC"

**Where:** `ExplorePage.tsx:2277` ("Mean EGC / total sample depth"). The value is `AVG(norm_egc)` over detected samples (`cache_sql.py:811-818` and the catalog's `mean_norm_egc`), i.e. a mean of per-sample ratios, not a ratio of means.

**Fix:** "Mean of the per-sample relative abundance (norm_egc) over the samples where detected".

---

### [L] Lookup card "Scaffolds (sample)" is the count from an arbitrary sample

**Where:** `ExplorePage.tsx:2301-2312`; `cache_sql.py:924-931` (`LIMIT 1`, deliberately unordered; the code comment says which sample it is is undefined). The tooltip says "in one sample this annotation appears in" but not that the sample is unspecified and can change between deployments. The number is presented as a property of the annotation (live: psbA shows 16 while its per-sample counts range 11-17).

**Fix:** drop the row, or show "N in <sample date>" by choosing a defined sample (e.g. the max or the first).

---

### [L] Enzyme group labels name the class, not the group

**Where:** `frontend/src/constants.ts:604-609` (`expandParentLabel('1.1.1', 'enzyme')` -> "1.1.1 · Oxidoreductases"). Used for the Top EGC "Group" column, the By Parent group headers and the Overview group list.

**Effect:** every enzyme group under class 1 is headed "... · Oxidoreductases"; the sub-subclass's own name (e.g. "With NAD+ or NADP+ as acceptor") is never shown, so the ranked group list for enzyme reads as a list of codes.

**Fix:** look the parent up by id (name is available for every catalog node) as the kegg/cog paths already do.

---

### [L] Annotations by Parent: "Trend Δ EGC" is "—" for every member after the first 20, indistinguishable from "too few points"

**Where:** `ExplorePage.tsx:1017-1028` (trend computed from `gs.data[row.annotation_id]`, which `loadGroupSeries` fills only for `items.slice(0, 20)`, `:770`). The truncation banner (`:926-938`) mentions only the summed chart.

**Fix:** say "not loaded" for members past 20, or load series for all members of the expanded group.

---

### [L] Scaffold charts run a line straight across samples where the term had no scaffolds; the same panel's CSV writes 0 for them

**Where:** `ScaffoldExplorePanel.tsx:41` (`buildScaffoldTrace` plots only the detected rows, so there is no 0 or null to break at -- `connectgaps: false` has no effect), vs. `:472` (`chartRows` fills missing dates with 0 for the CSV). Same in `ScaffoldModal.tsx:450-455` and `GroupScaffoldModal.tsx:611-616`.

**Effect:** a term absent from sample k is drawn as a line from k-1 to k+1 at the neighbouring counts, hiding a real 0; the downloaded CSV says 0. The EGC charts elsewhere break the line at non-detection, so the two chart families read differently.

**Fix:** build the trace from the full sample axis (as `MultiEgcChart` does) with 0 or null at undetected samples.

---

### [L] Minor label and state issues

- `ExplorePage.tsx:402`, `:432`, `:585`: "functional groups" / "Top Functional Groups" for taxonomy and enzyme sources.
- `ExplorePage.tsx:1639`, `:2010`, `ScaffoldExplorePanel.tsx:579`: rank-filter tooltips say "taxonomic rank(s)" for kegg/cog/enzyme.
- `ExplorePage.tsx:413-418`: "Mean EGC distribution · kegg" (StatsPanel, n = 200) is the distribution of the top 200 rows, not of the source.
- `ScaffoldModal.tsx:308-321`, `GroupScaffoldModal.tsx`: `/annotations/scaffolds/summary` returns 404 for an annotation with no scaffold rows (`routes.py:911-915`), which the modal reports as "Failed to load ... may have timed out"; the "No scaffolds found" branch is unreachable.
- `AnnotationInfoDrawer.tsx:94-101`: until `/kegg/path` resolves, the drawer shows the single stored parent (e.g. a rare category for a multi-parent KO), then swaps; and when the stored parent is null the Parent row is hidden even if real parents exist.
- `tests/test_frontend_page_size_contract.py` scans `page_size=` only; the Top EGC `limit` (NumberField max 200, `ExplorePage.tsx:1571`) vs the route's `le=200` is not pinned.

---

## Checked and found correct

- **Dataset Overview chart:** sums member series per timestamp (`sumMembersByTimestamp`), fetches with `loadedParams.source`, filters the chart by `loadedParams` dates (pinned by `dataset-overview-chart-date-filter`), discloses the 40-member fetch cap and failed members. Date bounds: backend inclusive, bare `date_to` covers the whole day (`index.py:63-93`); client filter uses `isoDate` inclusive on both ends -- consistent. No denominator claim is made.
- **Top EGC Annotations:** `mean_egc` is `AVG(egc)` over detected samples (unfiltered: catalog; date-filtered: `get_top_annotations_sql` over samples in range), `sample_count` per row is detections in range, "Based on N samples" is the number of samples in range. Sorting is stable per column; ties keep input order; "#" is the position in the current sort/filter (not a global rank -- header is "#", and a "N of M" count is shown when filtered). Rank pills read the real `depth` for every source. Multi-parent Group column uses `/kegg/parents` / `/cog/parents` with a disclosed single-parent fallback. `limit` <= 200 matches the route cap; the 200-row truncation is disclosed.
- **Annotations by Parent:** multi-parent KOs/COGs filed under every real parent (note in both tooltips); top-level categories last with a tooltip; series fetched under `loadedSource`; stale-source guard on rows and series; 20-member chart cap disclosed. No percent-of-parent is computed anywhere (the "Relative" column is a bar relative to the largest group).
- **Lookup hierarchy:** immediate parents and categories from `/kegg/path` (all paths; live K00134 has 9 paths, all depth 4) and `/cog/path`; stale-selection guard; "Samples N / 128" matches the dataset.
- **Scaffold panels:** the client never recomputes EGC from scaffold rows (only scaffold/gene counts are shown; per-scaffold depth is not exposed). Summary dates are unpadded "M/D/YY H:MM" (live), parsed and re-emitted as local time by `toPlotlyDate`, so the x-axis is correct in any browser zone. Detail lists page in SQL with a stable `ORDER BY scaffolds.id` and "Show all N" fetches the remaining pages. Nested members are dropped from sums by `filterRedundantAnnotations` (prefix check for taxonomy, real paths for kegg/cog/enzyme) and the note's wording is accurate; the sibling-overlap note ("counted once for each") is shown whenever >=2 terms are summed.
- **Mappings:** sample cap (5 samples when >20 leaves or >5,000 estimated rows, plus the 50,000-row budget) is reflected in the field, the banner and the empty state; "Export all" bypasses the sample cap but not the 50,000-row limit, and the banner says so. Samples are taken earliest-first (`routes.py:329-330`). There is no scaffold-id search in the UI (the route has none either).
- **Bulk Download:** column order and names in `COLUMNS_HELP` match `_EXPORT_HEADER` / `_EXPORT_PATHS_HEADER`; dates are `YYYY-MM-DD HH:MM`; undetected samples are `0,0,false` (dense) or omitted (sparse) exactly as the UI says and as `tests/sql/test_series_export_csv_contract.py` pins; only the requested level is written, plus the optional starting-term block; taxonomy `lineage` is the full lineage id; path choices key on `(term, immediate parent)` on both sides, and the live review for 09101/ko has no duplicate parent ids and no negative "outside" counts; file names come from `Content-Disposition`.
- **External links:** KEGG KO ids are bare `K#####` in the catalog (live), so `/entry/K02703` and the BRITE query are right; pathway/BRITE-file codes branch on the `[PATH:]`/`[BR:]` name markers; COG entry and category URLs use NCBI's current paths; full EC numbers link to both KEGG and ExPASy; the NCBI Taxonomy link is a search on the leaf name (labelled "Search NCBI Taxonomy"), so a homonym lands on NCBI's disambiguation list rather than a wrong taxon.
- **Stale-response guards present:** Overview `load`/`loadTemporalChart`, By Parent `loadTop`/`loadGroupSeries`, Top EGC `load`, Lookup search and parents, MappingsPanel `loadMappings`, ScaffoldModal detail (ref), GroupScaffoldModal effect (`cancelled`), BulkDownload summary/review effects, Scaffold Explore detail (`expandedSample` check).
- **Number formatting:** EGC is shown as `toExponential(2)` in tables and `(3)` on the Lookup card; relative abundance is a fraction on the Lookup card and a percent in chart tooltips (`formatRelativeAbundancePercent`, 3 significant figures) -- different conventions, but each is labelled; scaffold/gene stats are integers with a 1-decimal mean.

## Could not verify

- Whether a bulk download that fails mid-stream is reported as failed by the browser: `/series/export` is a `StreamingResponse` with no `Content-Length` or trailer; an exception in `_series_export_csv` ends the chunked body early. Browsers usually mark an incomplete chunked download as failed, but the file carries no row count or terminator to check against, and I did not reproduce a mid-stream failure.
- `/series/export/review` only for kegg 09101 -> KO (194 multi-path terms); whether any KEGG pathway appears under two subcategories (which would make `total_paths` count parents while `paths` counts lineages) was not checked across the whole hierarchy.
- The taxonomy "every rank adds up to the starting taxon's total" claim in `COLUMNS_HELP` is backed by `tests/sql/test_series_export_sql.py::test_unclassified_placeholders_are_included` (placeholders exist), not by a sum test; I did not sum a rank's rows against its parent live.
