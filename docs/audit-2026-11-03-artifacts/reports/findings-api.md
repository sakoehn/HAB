# Backend request-path audit (excluding the correlation finder)

Branch `feature/sqlite-integration`, HEAD `a993ead`, 2026-11-03. Files reviewed in full: `FastAPI/main.py`, `api/routes.py`, `api/cache_sql.py`, `api/index.py`, `api/cache.py`, `api/astronomy.py`, `api/db.py`, `api/config.py`, `api/taxon_lineage.py`, `scripts/create_sql_schema.py`, `scripts/create_sql_indexes.py`, `scripts/migrate_annotation_catalog_sql.py`; the frontend callers of each endpoint (`TaxonomyPage.tsx`, `utils/taxonomy.ts`, `ExplorePage.tsx`, `MappingsPanel.tsx`/`mappingsData.ts`, `BulkDownloadPanel.tsx`, `useAllSamples.ts`, `utils/solar.ts`). Verification used in-memory SQLite fixtures (`scratchpad/probe_fixture.py`, `plan_probe.py`, `plan_timing.py`), an independent sunrise computation (`scratchpad/suncheck.py`), ~20 read-only GETs against metatrace.uw.edu and two NOAA CO-OPS prediction requests for station 9449771. Backend tests: `.venv/bin/python -m pytest tests/ -m "not api"` gives 404 passed, 43 failed, 514 skipped; every failure is `FileNotFoundError` on the raw JGI files (`Metagenome_Samples/`, `KEGG/`, `COG_genes/`), none is a logic failure.

---

### [H] "Export all" mappings CSV is silently cut to 50 000 arbitrary rows

**Where:** `FastAPI/api/cache_sql.py:1325-1372` — every variant of the id subquery ends in `LIMIT {_MAPPINGS_ROW_LIMIT}` regardless of `bypass_cap`; `FastAPI/api/routes.py:399-406` skips `samples_within_row_budget` when `bypass_cap` is set; `frontend/src/components/mappings/MappingsPanel.tsx:166-181` (`downloadFullCsv`) reads only `r.data` and never looks at `results_were_truncated`; `:290-291` promises "Export all downloads every mapping row for this annotation across all 128 samples".

**What is wrong:** `bypass_cap=true` disables the sample-count cap and the whole-sample budgeting but not the hard row limit, so the export query returns the first 50 000 ids in index order — for kegg that is `(kegg_id, sample)` order, i.e. a prefix of the leaf ids in lexicographic sample order, not whole samples and not chronological. The on-screen truncation note (`MappingsPanel.tsx:366-378`, which does say "Export all" cannot go past 50 000) only appears when the *preview* itself hit the limit; a preview that was merely sample-capped shows the "every mapping row" promise instead.

**User-visible effect:** Analyze → any chart for KEGG pathway 00910 (Nitrogen metabolism) → View Annotation Mappings. Live: the preview is capped to 5 samples, 7 358 rows, `results_were_truncated=false`, so the panel offers "↓ Export all … every mapping row … across all 128 samples". The pathway has 253 121 mapping rows across the 128 samples (`/annotations/scaffolds/summary` gene_count sum). The CSV will contain 50 000 of them, an arbitrary subset, with no warning in the file or the UI. Any category/pathway/organism above 50 000 rows (every COG category, every KEGG A/B level, abundant species) behaves the same.

**How verified:** code read; fixture (`probe_fixture.py` PROBE1: 6 real rows, `_MAPPINGS_ROW_LIMIT=4`, `bypass_cap=True` → 4 rows returned); live preview and gene counts for 00910 as above. The actual bypass export was not run live (it is a multi-minute query).

**Suggested fix:** for `bypass_cap`, either stream the full result (iterate samples in chronological order with the budget applied per chunk, no LIMIT) or keep the limit but return `results_were_truncated` and have `downloadFullCsv` refuse/warn when it is set. Either way the "every mapping row" text must be conditional on the real total (`SUM(gene_count)` from `annotation_series`, already computed by `samples_within_row_budget`).

### [H] Search cannot find ids written with their `KO:`/`EC:` prefix; `EC:…` returns the wrong annotations

**Where:** `FastAPI/api/routes.py:496-504` and `FastAPI/api/cache_sql.py:897-913` — `get_search_annotations` matches `q`/`annotation_id` verbatim; `strip_source_prefix` (used by `/series/annotations` and `/mappings/search`) is never applied here. `frontend/src/pages/MethodsPage.tsx:68-71` gives `EC:1.1.1.1 · EC:4.2.1.17` as the example ids.

**What is wrong:** the catalog stores bare ids (`1.1.1.1`, `K00001`). `q=KO:K00001` matches nothing. `q=EC:1.1.1.1` matches only KO *names* that contain the text (K00059 "… [EC:1.1.1.100]" etc.), so the response is 41 KEGG rows and not the enzyme the user asked for. The `annotation_id=` exact form has the same gap.

**User-visible effect:** Explore → Annotation Lookup, source Enzyme, "EC:1.1.1.1" (the format the Methods page shows): "0 results". Analyze search box, all sources, "EC:1.1.1.1": 41 KEGG orthologs, none of them alcohol dehydrogenase. Live: `q=KO:K00001` → total 0; `q=EC:1.1.1.1` → total 41, all source kegg; `q=K00001` → 1.

**How verified:** live requests; code read.

**Suggested fix:** in `get_search_annotations`, build the id predicate per source with `strip_source_prefix(source, q)` (or match `annotation_id IN (bare, 'KO:'||bare, 'EC:'||bare)`), and strip the prefix for the `annotation_id` exact branch too.

### [M] Exact-id matches are not ranked first, so a looked-up id can be absent from the lookup result

**Where:** `FastAPI/api/routes.py:507` (sort by `mean_egc` only), `FastAPI/api/cache_sql.py:907-913` (`LIKE '%q%'` on id and name, no exact-match term); `frontend/src/pages/ExplorePage.tsx:1349` fetches `page_size=25`.

**What is wrong:** a query that is itself an id is a substring of many longer ids (`2.7.1.1` is inside `2.7.1.10 … 2.7.1.199`), and the only ordering is mean EGC. The exact match sits wherever its abundance puts it.

**User-visible effect:** Explore → Annotation Lookup, Enzyme, "2.7.1.1" (hexokinase, in the catalog with 80 samples): the card says "62 results · showing 25 · sorted by mean EGC" and hexokinase is not among them (live rank 43 of 62). "1.1.1.2" appears at position 15, "1.1.1.4" at 17 — on the page, but below a dozen other enzymes. Analyze loads all 5 000 rows so the exact id is present but buried at the same rank.

**How verified:** live requests (`q=2.7.1.1&sources=enzyme&page_size=25`, `page_size=100`, and `annotation_id=2.7.1.1`).

**Suggested fix:** `ORDER BY (annotation_id = :q OR name = :q) DESC, mean_egc DESC` (bare and prefix-stripped), then paginate; update `tests/sql/test_search_annotations_sql_route.py::test_results_sorted_by_mean_egc_descending` to allow the exact match first.

### [M] "Top EGC Annotations" ranks top-level categories next to their members and cannot show the top N at a rank

**Where:** `FastAPI/api/routes.py:762-831` (`/annotations/top` has no depth/rank parameter); `frontend/src/pages/ExplorePage.tsx:1252` (fetches `limit=N`), `:1420-1436` (rank pills filter the already-fetched N rows; no `parent == null` separation in this view), `:1639` ("doesn't re-fetch, just filters what's already loaded"). `MethodsPage.tsx` "Hierarchies roll up": top-level categories "are shown separately on the Explore page instead of being ranked next to the groups they already contain" — true for Dataset Overview and Annotations by Parent, not for this view.

**What is wrong:** because every ancestor's EGC is the sum of its descendants, the server's top N is dominated by rollups. Live, `source=kegg&limit=25` returns 8 depth-1 branches (ranked 1, 2, 5, …), 13 depth-2, 4 depth-3 and zero KOs; `source=taxonomy&limit=25` mixes all eight ranks. The rank pills can only subtract from that list, so "top 25 KOs" is unobtainable (the KO pill is not even offered for a 25-row result) and a filtered list has an unspecified length.

**User-visible effect:** Explore → Top EGC Annotations, KEGG, limit 25: rank 1 is "09180 Brite Hierarchies", rank 2 "09100 Metabolism". Choosing a rank pill at limit 200 yields a handful of rows that are the top-K at that rank for an unknown K.

**How verified:** live `/annotations/top` depth distributions; code read.

**Suggested fix:** add `depth` (or `min_depth` / `exclude_top_level`) to `/annotations/top` and push it into both SQL paths (`AND depth = ?` on `annotation_catalog`; cheap), include it in the cache key, and have the Top view send the selected rank instead of filtering client-side.

### [M] `include_parent=true` returns a 500 for a parent that has no detected data

**Where:** `FastAPI/api/routes.py:1076-1078` — `next(p for p in get_paths_under_at_depth_sql(...) if p["annotation_id"] == parent)` with no default; `get_paths_under_at_depth_sql` (`cache_sql.py:1593`) only returns terms with an `annotation_catalog` row.

**What is wrong:** `_paths_levels` accepts any term present in `kegg_paths`/`enzyme_paths`/`cog_paths`; if that term never had a detected descendant it has no catalog row, `next()` raises `StopIteration`, and `/series/export` and `/series/export/summary` (GET and POST) answer 500 instead of 400/404. Also fetches every term at `parent_depth` in the whole dataset to find one.

**User-visible effect:** API only. The Bulk Download panel picks the start term from `/search/annotations` (catalog-backed), so the UI cannot reach it.

**How verified:** fixture (`probe_fixture.py` PROBE2: parent `00010` in `kegg_paths`, catalog has only `K00001` → `StopIteration`).

**Suggested fix:** `next(..., None)` → 404 "no data under …", or build the start labels from the paths table directly (`WHERE {col} = ?` without the EXISTS clause).

### [L] `/annotations/top` cache key conflates a bare date with the same date at 00:00

**Where:** `FastAPI/api/routes.py:797-801` keys on `_parse_any_datetime(x).isoformat()`; `FastAPI/api/index.py:89-94` treats a bare `date_to` as the whole day but a timed one as ending at that time.

**What is wrong:** `date_to=2021-06-05` and `date_to=2021-06-05T00:00:00` share the key but select different samples (the first includes "6/5/21 21:00", the second does not); whichever is asked first is served for both for 30 minutes. The UI only sends bare dates, so this is API-only.

**How verified:** computed (`probe_fixture.py` PROBE4).

**Suggested fix:** key on the normalised string plus a bare-date flag, or normalise a bare `date_to` to `T23:59:59` before both keying and filtering.

### [L] `/timepoints` and `/samples` are not chronological

**Where:** `FastAPI/api/routes.py:231` (dict order of the CSV), `:245` and `cache_sql.py:106` (`ORDER BY sample`, i.e. by taxon_oid).

**Effect:** live `/timepoints?page_size=200` starts at 5/27/21 13:00 and ends at 6/15/21 5:00; `/samples` is lexicographic. The app sorts client-side (`useAllSamples.ts:337`), so only API consumers see it. **Verified live.** Fix: `sorted(rows, key=timepoint_sort_key)` in both.

### [L] `/tides` labels only the high/low events that land on the 6-minute grid

**Where:** `FastAPI/api/cache.py:112-131` passes `tide_event` through from `tides.csv`.

**Effect:** on 2021-06-03 NOAA lists four extrema (01:01 H, 08:16 L, 12:36 H, 17:34 L); the API labels only the 12:36 High. The frontend ignores `tide_event` (type only, `solar.ts:12`), so this misleads API consumers only. **Verified live against NOAA hilo predictions.** Fix: drop the field or label local extrema of the series.

### [L] `/annotations/scaffolds` and `/annotations/scaffolds/summary` reject the prefixed id form the other routes accept

**Where:** `FastAPI/api/routes.py:855-859, 900` pass `annotation_id` unstripped. Live: `/annotations/scaffolds/summary?source=enzyme&annotation_id=EC:1.1.1.1` → 404, while `/series/annotations` with the same id → 128 rows. UI passes bare ids. **Verified live.** Fix: `strip_source_prefix`.

### [L] `results_were_truncated` is true when the result is exactly 50 000 rows

**Where:** `FastAPI/api/routes.py:429` (`len(mappings) >= _MAPPINGS_ROW_LIMIT`). A node whose budgeted samples total exactly 50 000 rows is reported as truncated. **Computed** (`probe_fixture.py` PROBE5). Fix: fetch `LIMIT + 1` and compare, or compare the budgeted row sum to the limit.

### [L] Unsynchronised top-annotations cache can raise `KeyError`

**Where:** `FastAPI/api/routes.py:170-190`. Routes run in the threadpool; two requests that both see an expired entry both execute `del _TOP_ANN_CACHE_SQL[key]`, and `move_to_end(key)` can follow a concurrent `popitem` — either raises and the request 500s. Rare (TTL boundary / cache full). **Read only.** Fix: a `threading.Lock` around get/set, or `pop(key, None)`.

### [L] Hard-coded constants and a stale reference document

- `routes.py:281` returns `"tz_offset": -7` instead of `LOCATION_TZ_OFFSET`; `routes.py:293` `sample_count le=128`; `MappingsPanel.tsx:167` `FULL_SAMPLE_COUNT = 128`; `ExplorePage.tsx:2106, 2297` "of 128". All match the live dataset today (`/samples` total 128).
- `index.py:105` derives `DATA_DATE_MIN/MAX` from all 132 CSV rows, while `/timepoints` filters to the 128 real samples (`routes.py:204-216`). No effect today: `/status` gives 2021-05-27..2021-06-18 and the real samples span 5/27 13:00 .. 6/18 09:00.
- `endpoint_query_reference.md` describes a Mongo/in-memory architecture (`/annotations/correlate`, `/mongo-test`, `_EGC_MATRIX`) that no longer exists.

---

## Performance

### Date-filtered `/annotations/top` scans the whole source partition (54 s live)

**Where:** `FastAPI/api/cache_sql.py:807-823` (`WHERE source = ? AND sample IN (...) GROUP BY annotation_id`).

**What happens:** the planner uses `idx_annotation_series_source_annotation_id (source=?)` and walks every row of the source (taxonomy ≈ 5 M of the 7 M rows) to test `sample IN (...)`. Live: `source=taxonomy&limit=5&date_from=2021-06-02&date_to=2021-06-04` (18 samples) took **54.1 s**, within sight of the 60 s nginx timeout noted in the previous audit (N1); the result is then cached for 30 min per exact range only. Dataset Overview and Top EGC Annotations both issue this request whenever a date range is set.

**Better plan:** the `UNIQUE(source, sample, annotation_id)` autoindex already supports `(source=?, sample=?)` seeks, and each sample's rows are contiguous (the migration inserts per source per sample). `EXPLAIN` on a 1.2 M-row fixture: as written → `SEARCH … (source=?)`; with `INDEXED BY sqlite_autoindex_annotation_series_1` → `SEARCH … (source=? AND sample=?)`; `ANALYZE` alone did not change the chosen plan. Rewrite as a row-value `(source, sample) IN (VALUES (?,?),…)` predicate, or aggregate per sample in Python (one indexed query per sample, ≤128), or add an explicit `(source, sample)` index. Expected gain: work proportional to the samples in range (18/128 of one partition, read sequentially) instead of the whole partition — seconds rather than a minute on the production disk, and no 504 exposure.

### First call to `get_all_sample_names_sql` is a full scan of the 74 M-entry mappings index

**Where:** `FastAPI/api/cache_sql.py:106` (`SELECT DISTINCT sample FROM mappings ORDER BY sample`), cached per process with no lock.

**What happens:** plan is `SCAN mappings USING COVERING INDEX idx_mappings_sample_gene` (fixture EXPLAIN) — every index entry is visited to produce 128 values. It runs on the first `/timepoints` (the app's online ping), `/samples`, `/mappings/search`, `/annotations/top` or `/series/export` after each restart, and concurrently if several requests arrive at once. Not measurable live (process warm); `create_sql_indexes.py` records 143 s for a similar DISTINCT over the smaller `annotation_series` before it was indexed.

**Better plan:** a loose index scan — `WITH RECURSIVE s(x) AS (SELECT MIN(sample) FROM mappings UNION ALL SELECT (SELECT MIN(sample) FROM mappings WHERE sample > x) FROM s WHERE x IS NOT NULL) SELECT x FROM s WHERE x IS NOT NULL` (128 seeks; plan verified) — or reuse `load_sample_order`'s `SELECT DISTINCT sample FROM annotation_series` (indexed, 0.3 s per the index script) and compute once in `lifespan`. Expected gain: first-request latency after a restart from a full index scan to milliseconds.

### Minor

- `get_top_annotations_from_catalog_sql` (`cache_sql.py:848-856`) returns the whole per-source catalog (≈68 800 taxonomy rows) to keep 200; add `LIMIT 200` (cached, so small gain).
- `/search/annotations` fetches every match (two correlated subqueries per row) and sorts/paginates in Python: 0.86 s for the 6 119 "protein" matches — acceptable; `ORDER BY … LIMIT/OFFSET` in SQL would cut it further.

---

## Checked and found correct

- **Taxonomy exclude / keep-only (Q2):** done client-side from `/series/annotations` for the scope and each checked branch (`TaxonomyPage.tsx:129-159`, `utils/taxonomy.ts:63-176`). Per sample, `egc` and `norm_egc` are subtracted (or summed) on the scope's sample axis; a branch absent from a sample contributes 0; a checked branch nested under another checked branch is dropped before summing (`filterRedundantExclusions`, lineage-prefix test), so multi-level selections never double-subtract. Because taxonomy EGC is a strict rollup (each gene has one lineage) and `norm_egc` divides by one per-sample total shared by all nodes, both subtractions are exact.
- **Sunrise/sunset (Q7):** `astronomy.py` is a faithful Almanac-for-Computers implementation; against an independent NOAA-spreadsheet computation all 23 dates agree within 0.6 min (e.g. 2021-06-01 05:13/21:06). UTC→PDT uses `LOCATION_TZ_OFFSET=-7`; the sunset-past-midnight-UTC case is handled by the algorithm's `t` term, so each local date gets its own evening. The frontend parses "HH:MM" with the "YYYY-MM-DD" key as local time, same as sample times.
- **Tides (Q7):** after `TIDE_SHIFT_HOURS=+1`, the live series equals NOAA's predictions in local daylight time to 0.000 m at all 240 six-minute points on 2021-06-03 (and differs by up to 0.36 m if the shift were absent) — the shift direction and magnitude are right, and `/tides` and `/sun-times` are on the same PDT clock. Coverage 2021-05-27 01:00 .. 2021-06-19 00:54 brackets the samples.
- **`/status`, sample count:** date range equals the real sample min/max; `/timepoints` filters the 4 never-processed CSV rows (total 128); `index_ready` is set in `lifespan`.
- **`/series/annotations`:** one row per detected sample (UNIQUE constraint), chronological by parsed datetime, `KO:`/`EC:` accepted, 404 when nothing found, `page_size` cap documented in the About page.
- **`/series/export` family:** samples chronological with ISO "YYYY-MM-DD HH:MM"; undetected samples written as `0,0,false` (dense) or omitted (sparse, when `max_rows > 1 048 575`), with the `detected` column and the summary's `sparse` flag saying which; entry order and series order are both BINARY-collated on the same strings and the 500-id chunking preserves global order, so the `groupby` walk aligns; taxonomy `lineage` = the node id to that rank, kegg/cog/enzyme `lineage_ids`/`lineage` " > "-joined; `exclude` only applies at depth > 1; `date_from/date_to` validated before streaming.
- **`/annotations/top`:** both paths average over detected samples only (catalog `AVG(egc)`; date path `AVG` over rows in range) and the UI labels it "mean when detected"; ranking by `mean_egc`; slice after sort; bare-date bounds are inclusive whole days (06-02..06-04 → 18 samples); unparseable bounds → 400.
- **Hierarchy endpoints (Q6):** roots are `DISTINCT` + sorted (8 KEGG, 25 COG, 7 EC, 4 domains); depth by column membership (KEGG/COG) or dot count (EC) or segment count (taxonomy); `/kegg/path`, `/cog/path` `GROUP BY` the ancestor columns so multi-parent nodes get one path per real lineage; bulk parents resolve from the deepest level up; a leaf parent returns `[]` not 404; empty `parent=` is treated as omitted.
- **`/mappings/search` (Q5):** cog/enzyme subqueries select `DISTINCT mapping_id`, so a gene with two COGs under one category is one row (matches "once per category"); `samples_within_row_budget` predicts with `annotation_series.gene_count` (same definition) and takes whole samples chronologically; `sample_count`, `samples_were_capped`, `leaf_count`, `results_were_truncated` are all returned and the panel shows them for the on-screen table; unique-pairs keeps each pair's earliest occurrence (stable sort).
- **`/search/annotations` (Q4):** substring, case-insensitive on `name` (all sources) and on `annotation_id` (non-taxonomy), LIKE metacharacters escaped; 1–2 character queries are exact-id lookups (COG letters, EC classes); taxonomy matches the bare name only, by design; `total` is always the full count and the three pages that cap at 500/5000 say "showing N of total".
- **Concurrency:** every route is a sync `def` (threadpool) with its own short-lived connection; WAL mode; `tests/sql/test_routes_do_not_block_event_loop.py` pins this.

## Could not verify without the database or raw data

- Scaffold/gene counts against the JGI files and the EGC definition (`test_scaffold_ground_truth.py`, `test_egc_api_vs_jgi.py` need `Metagenome_Samples/`, `KEGG/`, `COG_genes/`).
- That `annotation_series.category`/`parent`/`depth` are constant per `(source, annotation_id)` on the live table (the code relies on it with `MIN()` / unordered `LIMIT 1`).
- That `JGI_ID_Timepoints_128.csv` is itself in PDT: the only evidence is the tide cross-reference in `cache.py`, which is consistent, but no field metadata is available.
- Production SQLite version and `ANALYZE` state (local is 3.45.1; a 3 484-id `IN` list worked live, so the server is ≥ 3.32 with the 32 766 bound-parameter limit).
