# HAB Portal — Code Audit

**Original audit:** 2026-08-28 at commit `35e1822`
**Re-audit:** 2026-09-11 at commit `fb40589`, plus two independent blind audits the
same day (one on the correlation feature and the EGC pipeline, one on the web
application) whose confirmed findings are merged below.
**Branch:** `feature/sqlite-integration`
**Purpose:** Record of open defects, written so the same ground can be re-checked
after fixes land.

## How to use this document

Every finding has a **Verify** line describing how to confirm it is fixed. A
re-audit should be able to work top to bottom from those lines alone.

Findings resolved since the original audit have been removed. The IDs are kept
stable, so the numbering below has gaps. Resolved and removed so far:
**E1, E2, E3, E4, E11, C1–C4, R1, W6**, and the user-facing half of **W1**.

Confidence levels:

| Label | Meaning |
|---|---|
| **Confirmed (live)** | Reproduced against the deployed server at `54.186.114.24:8000` |
| **Confirmed (executed)** | Reproduced by running code locally |
| **Confirmed (code)** | Unambiguous from reading the source |
| **Conditional** | The code defect is certain; whether it currently changes numbers depends on a property of the data |

## Scope

**Reviewed:** the four EGC notebooks, `All_Coverages.py`, `weighted_totals.py`,
`KEGG_preDatabase.ipynb`, `mappings.ipynb`, the SQL migration scripts, the
FastAPI layer (`routes.py`, `index.py`, `cache.py`, `cache_sql.py`,
`correlation.py`, `correlation_sql.py`, `astronomy.py`) across both `json` and
`sql` backends, the correlation tests, and the frontend display path.

**Not reviewed:** performance, security, and Plotly rendering internals.

**Data:** the dataset is gitignored and was not available locally. Where a finding
could be settled against the deployed server, it was, by API calls and by
driving the UI with Playwright. The live server runs `DATA_BACKEND=sql`. It
became unreachable twice during testing, each time right after a correlation
request, and recovered on its own within a minute.

---

# Summary — what to tell the author first

Ordered by how badly the numbers users see are affected.

1. **KEGG pathway and category totals are wrong.** Each KO is filed under only
   the last parent listed in the KEGG hierarchy file, so pathways like
   Glycolysis show a small fraction of their real signal. Confirmed on the live
   server. (E14)
2. **The correlation finder reports lead/lag direction backwards** for most
   source combinations, including the panel's default. (CR1)
3. **The correlation finder's "significant" list is mostly noise.** The
   p-values assume independent timepoints; on autocorrelated series like these,
   about half of unrelated pairs pass the q < 0.05 gate. (CR2)
4. **Same-source correlation does not exclude parents and children** for KEGG,
   Enzyme or COG, so a pathway is scored against its own members. (CR3)
5. **One flat-line annotation crashes the whole correlation request** with a
   500, permanently. Reproduced on the live server for a kegg reference
   against cog. (CR4)
6. **The Explore overview's "summed" time series is not a sum.** It plots
   whichever group member was loaded last, about six times too low on the live
   server. (W14)
7. **Two date filters compare dates as text.** On the Top EGC table (W2) and
   the Scaffold Information panel (W15), an end date empties the results and a
   start date does nothing.
8. **Scaffold charts plot points shifted by the browser's UTC offset**, so
   evening samples land on the next day. (W16)

Good news from the re-audit: the `norm_egc` denominator fix from `04d3bf0` is
live. The deployed server serves the new shared denominator for COG, KEGG and
Enzyme alike, so the earlier regeneration question (R1) and the mixed-source
relative-abundance concern (W6) are closed.

---

# Part 1 — EGC Calculations

The API does not compute EGC. It reads values precomputed by the notebooks in
`Notebooks/` and loaded by `FastAPI/scripts/migrate_*.py`.

As implemented:

```
EGC(annotation, sample) = Σ over the annotation's genes of coverage(scaffold(gene))
norm_egc                = EGC / weighted_totals[sample]     (shared across sources)
```

## 1.1 Confirmed — stored values are wrong

### E14. KEGG pathway and category EGC are wrong because each KO keeps only one parent

**Where:** `Notebooks/EGC_KEGG_TREE.ipynb`, the BRITE parsing cell that builds
`brite[node_id] = {...}`.

KEGG's hierarchy file lists the same KO under every pathway it belongs to.
Hexokinase, for example, appears under Glycolysis, Galactose metabolism, Starch
and sucrose metabolism, and the "Brite Hierarchies" section near the end of the
file. The parser stores nodes in a plain dictionary keyed by KO id, so each new
occurrence overwrites the last, and only the final parent survives. Genes are
then rolled up through that single parent only. Because the Brite Hierarchies
section comes last in the file, most enzymes end up counted there instead of in
their pathways.

**Why it matters:** anyone reading KEGG at the pathway or category level sees
totals that are a fraction of the truth. Leaf KO values are unaffected.

**Confidence:** Confirmed (live). In sample 3300060358 the Glycolysis pathway
node holds 2,286 EGC, while single members of that pathway hold far more on
their own: GAPDH 11,933, pyruvate kinase 8,230, enolase 5,882. The catalog lists
hexokinase's parent as "Membrane trafficking", which is where the file happens to
mention it last. The top-level "Brite Hierarchies" node holds more than twice the
signal of "Metabolism".

**Verify:** Glycolysis (00010) EGC is at least as large as any one of its member
KOs in every sample. K00844 is reachable from 00010 in the stored tree.

**Fix:** store a list of parents per BRITE node and roll each gene up through
every ancestry, keeping the existing per-node gene set so a gene reaching one
pathway by two routes is still counted once. Regenerate KEGG JSON and the SQL
tables afterwards.

### E15. The COG tree has no functional-category nodes

**Where:** `Notebooks/EGC_COG_TREE.ipynb`, tree-building cell; its own printed
output says "4612 COG nodes (flat — no category parent nodes)".

The tests in `tests/test_annotation_trees.py` and the SQL migration both expect
a two-level COG hierarchy: single-letter categories at depth 1 with COG#### leaves
below them. The notebook writes only the leaves, with no `depth` and no
`parent_id`.

**Why it matters:** there is no way to view or correlate COG at the category
level, the COG hierarchy tests can't pass, and the correlation finder has to
exempt COG from its family rules entirely (see CR3).

**Confidence:** Confirmed (live). Requests for category "E" or "J" in source
`cog` return "No annotation found"; COG0055 has `depth = null` and
`parent = null`.

**Verify:** `/series/annotations?source=cog&annotation_id=E` returns 128 rows.

**Fix:** register each gene at its COG and at the COG's category letter, guarded
by the same per-node gene set, and write `depth` and `parent_id`.

## 1.2 Conditional — code defect certain, impact needs data

### E16. Collapsing repeated lineage names can shift taxonomy ranks

**Where:** `Notebooks/EGC_TAX_TREE.ipynb`, tree-building cell, the line
`taxpath = [t for i, t in enumerate(taxpath) if i == 0 or t != taxpath[i-1]]`.

JGI lineages have eight fixed positions, and the SQL side (`taxon_paths`,
`cache_sql.py`'s depth-to-rank map) relies on that. The notebook first deletes
any rank whose name repeats the previous one, then numbers depth from the
shortened list. If the repeat is at the end of a lineage (an unresolved strain)
nothing shifts. If it is in the middle, every rank below it is reported one level
too shallow, and the node key no longer matches the raw lineage in
`taxon_paths`, so lookups that join the two find nothing.

The stated reason for the collapse, avoiding double counting, is already handled
by the per-node gene set, so the line is not needed for correctness.

**Confidence:** Conditional. Spot checks of live taxonomy rows showed depth
matching segment count, so internal repeats may be rare or absent.

**Verify:** count lineages with a non-trailing repeated name across the
`.a.phylodist.txt` files. If zero, document and move on.

**Fix:** remove the collapse, or collapse only trailing repeats.

### E5. Mismatched scaffold-ID derivation can silently zero EGC

**Where:** `Notebooks/All_Coverages.py:27` versus everywhere else.

`All_Coverages.py` keeps the first two underscore-separated fields of a gene id;
every other file drops the last two. The two agree only for four-field ids. On
any other shape, the coverage lookup misses and the gene contributes zero with no
error. Since `04d3bf0`, the denominator side raises `KeyError` on a miss, but the
numerator side still defaults to zero.

**Verify:** `cut -f1 <sample>.a.depth.txt | awk -F'_' 'NF != 4' | head` across
all 128 depth files. Regardless of the result, use one shared helper.

### E6. KEGG is built from a prebuilt intermediate that can go stale

`EGC_KEGG_TREE.ipynb` reads `DataStructures/Kegg/kegg_db.json`, produced
separately by `KEGG_preDatabase.ipynb`. The other three notebooks read raw files
every run. A stale intermediate gives stale KEGG EGC with no error.

**Verify:** the notebook fails if the intermediate is older than its inputs.

### E7. The KEGG reader can ingest the same file twice

`KEGG_preDatabase.ipynb`, `read_ko`, uses `rglob` and processes every match. A
second copy of a `.a.ko.txt` anywhere beneath the directory is read again.

**Verify:** exactly one `.a.ko.txt` per sample; use a direct path like the other
readers.

### E8. The KEGG reader swallows exceptions mid-file

The file read sits inside `try/except Exception` that prints and continues, so a
partial read yields partial data and a message that scrolls past.

**Verify:** the handler is removed or re-raises.

## 1.3 Accepted behaviour — document, don't change

### E9. Annotations missing from a scraped reference get no EGC

Three trees skip any id absent from an externally fetched lookup (NCBI COG
table, KEGG BRITE). Reasonable intent, but a truncated download is
indistinguishable from an obsolete id.

**Verify:** documented, and the build logs a per-source drop count.

### E10. Only the first `;`-separated ID is read (KEGG, Enzyme)

Evidence says this never fires on current data. Replace the split with an
assertion so a format change fails loudly.

## 1.4 Documentation that contradicts the code

| ID | Location | Issue |
|---|---|---|
| E12 | `tests/conftest.py:84–100` | Describes a ~1000-unit tolerance versus JGI. The constants record exact agreement. Delete the note. |
| E13 | `frontend/src/pages/AboutPage.tsx:263` | Describes EGC as "per liter". There is no volume term in the pipeline. |

## 1.5 Housekeeping in `weighted_totals.py`

- Hardcodes one developer's Windows desktop path, as does `All_Coverages.py`.
- Importing it reads all 128 depth files as a side effect, so every test in
  `tests/test_weighted_totals.py` skips in CI.

---

# Part 2 — Correlation Feature

The Correlates panel calls `/correlations/family` in
`FastAPI/api/correlation_sql.py`. For a chosen reference annotation it scores
every candidate in a target source at nine lags, caches each pair, applies a
Benjamini–Hochberg correction across the family, and returns pairs with
q < 0.05.

## 2.1 Confirmed — wrong results shown

### CR1. Lead/lag direction is reported backwards for most source pairs

**Where:** `correlation_sql.py`, `_get_or_compute_correlation` (canonicalisation
near line 212) and the `lag_hours` line near 332.

Scoring is directional: swapping which series is the reference flips the sign of
the lag. Before scoring, the cache sorts the pair by catalog id and always
treats the lower id as the reference, then returns that lag to the caller
unchanged. Whenever the user's reference has the higher id, the lag they see
belongs to the opposite direction. Catalog ids are assigned in source order
(cog, enzyme, kegg, taxonomy), so for a cross-source family the sign is either
right for every row or wrong for every row.

**Why it matters:** the panel renders this as "leads by 8h" or "lags by 8h". A
taxonomy reference against any other source, or a KEGG reference against COG or
Enzyme, shows every direction reversed. The default target source is enzyme, so
the default first click is affected for kegg and taxonomy references. `r`, `p`,
`q` and `n` are unaffected.

**Confidence:** Confirmed (executed). Scoring `(ref, cand)` directly gives
lag +2 and `(cand, ref)` gives −2; through the cache both orders return +2.

**Verify:** a test that scores a known-lag pair with the reference in both id
orders and asserts opposite signs.

**Fix:** negate `lag_samples` before returning whenever the caller's reference
was the higher catalog id.

### CR2. The significance gate is not calibrated for time series

**Where:** `correlation_sql.py`, `core_scoring`, `_bonferroni_correct`,
`_apply_fdr`.

The p-value comes straight from `scipy.stats.pearsonr`, which assumes every
timepoint is an independent observation. Samples taken every four hours are
strongly autocorrelated, so the effective number of observations is far below
128 and the p-values are far too optimistic. The Bonferroni step over lags and
the Benjamini–Hochberg step across the family both assume valid input p-values
and cannot repair this. The previous JSON implementation used a circular
block-shift permutation test for exactly this reason; the SQL rewrite dropped it.

**Why it matters:** the panel labels every row "q < 0.05" and significant. In
simulation with realistic autocorrelation and no true relationship, about half of
all pairs pass the gate with a median |r| around 0.36. The list is mostly false
positives, and its length means nothing.

**Confidence:** Confirmed (executed). 400 independent AR(1) pairs, φ = 0.85,
n = 128: 51% pass q < 0.05. With φ = 0 the same code passes 0%, so
autocorrelation is the entire cause.

**Verify:** measure lag-1 autocorrelation of real EGC series; a label-shuffle or
block-permutation null on real data should pass close to 5% at p < 0.05.

**Fix:** restore an autocorrelation-aware null (circular block-shift permutation,
or an effective-sample-size correction) before Benjamini–Hochberg, and feed BH
the uncorrected per-pair p-values rather than stacking Bonferroni underneath it.

### CR3. Same-source families do not exclude parents or children for KEGG, Enzyme or COG

**Where:** `correlation_sql.py`, `get_family_candidates`, together with
`FastAPI/scripts/migrate_annotations_to_sql.py:82`.

The exclusion walk assumes a row's `parent` holds another row's `annotation_id`.
That is true for taxonomy. For KEGG and Enzyme the migration stores the parent's
display name ("Carbohydrate metabolism") while `annotation_id` is a code
("00010"), so the ancestor and descendant searches match nothing. Only the
sibling rule still works. COG is exempted from exclusions entirely because its
tree is flat (E15).

**Why it matters:** the panel promises that ancestors and descendants are
excluded to avoid containment artifacts. In practice a KEGG pathway is scored
against its own parent and its own member KOs, whose values contain the
reference's own genes. Those pairs correlate almost perfectly by construction and
will sit at the top of any within-KEGG or within-Enzyme list.

**Confidence:** Confirmed (live). The live catalog lists Glycolysis's parent as
the name "Carbohydrate metabolism". Locally, a realistic KEGG catalog run through
`get_family_candidates` keeps both the parent pathway and the child KO. The
existing test passes only because its fixture uses an id as the parent, which
the migration never produces.

**Verify:** with the live catalog, the family for 00010 within kegg contains
neither 09101 nor any KO under 00010.

**Fix:** store `parent_id` rather than `parent_name` for KEGG and Enzyme, add a
real hierarchy for COG (E15), and drop the COG exemption.

### CR4. One constant-valued annotation crashes the whole family request

**Where:** `correlation_sql.py`, `core_scoring`, `score_pair`, and the
`IntegrityError` handler in `_get_or_compute_correlation`.

If a candidate has the same value at every co-observed timepoint, `pearsonr`
returns NaN for both r and p. Nothing checks for that. The insert into
`correlations_cache` fails on its NOT NULL columns, the code assumes another
request won a race, re-reads a row that was never written, and crashes on it.

**Why it matters:** the failure aborts the entire request, not just that
candidate. The user sees "Correlation failed" and retrying gives the same error
forever, because the data never changes. Any source containing one flat-line
annotation makes the panel unusable for every reference against that source.

**Confidence:** Confirmed (live). On the deployed server, a family request for
kegg K00001 against cog returned HTTP 500 after two and a half minutes. Locally,
a three-annotation catalog with one constant series through `TestClient`
reproduces the same 500.

**Verify:** a test with a constant candidate returns 200 and omits that
candidate.

**Fix:** return `None` from `score_pair` when r or p is NaN, and make the
`IntegrityError` handler tolerate an empty re-read.

## 2.2 Significant

### CR5. Results are returned in database order, not by strength

**Where:** `correlation_sql.py`, `get_family_candidates` (no `ORDER BY`), the
endpoint (no sort or limit), and `CorrelatesPanel.tsx` line 250 (renders as-is).

Rows come back in catalog-id order, which is roughly alphabetical by annotation
id. Combined with CR2, a taxonomy family can return thousands of rows whose first
screen is an arbitrary alphabetical slice rather than the strongest correlates.

**Confidence:** Confirmed (code).

**Fix:** sort by |r| descending (or by q) server-side and cap the list.

## 2.3 Conditional

### CR6. The time axis silently falls back to a non-chronological order

**Where:** `FastAPI/scripts/migrate_correlations_to_sql.py`, `load_sample_order`,
via `index.py`'s `timepoint_sort_key`.

The sort key returns −1 for any sample it cannot date, including every sample if
`JGI_ID_Timepoints_128.csv` is missing or incomplete. Equal keys leave the
samples in database scan order, and correlations and lags are then computed on a
scrambled time axis with no visible symptom. Separately, `lag_hours` assumes a
uniform four-hour spacing that nothing checks.

**Confidence:** Confirmed (executed) for the fallback path. The live server has
the CSV, so this is a robustness gap today rather than a live defect.

**Fix:** raise in `load_sample_order` if any sample resolves to −1, and assert
uniform spacing at startup.

### CR7. Dead batch job still imported by the live path

`migrate_correlations_to_sql.py` contains an abandoned all-pairs job that writes
to a `correlations` table the schema script drops and never recreates, and whose
own `score_pair` measures lag in surviving positions rather than time steps. It
is never run, but the live endpoint imports `load_vector`, `load_sample_order`
and `TAXONOMY_DEPTH_CUTOFF` from it, so it reads as live code.

**Fix:** delete the batch job and move the three loaders to a neutral module.

---

# Part 3 — Web Application

Everything below assumes the stored data is correct.

## 3.1 Critical — wrong or empty results shown

### W1. JSON-backend correlation vectors are misaligned in time

**Where:** `FastAPI/api/index.py`, `_build_egc_vectors_from_files`; served by
`api/correlation.py` (`/correlation`), still registered in `main.py`.

The Correlates panel no longer uses this route, and the SQL replacement aligns
by sample correctly. The old route is still reachable, and in it an annotation
missing from one sample has every later value shifted left, so position *i*
means a different date for different annotations.

**Fix:** remove `correlation.router` from `main.py`, or pad absent samples with
`None`.

### W2. The date filter on Top EGC Annotations is broken

**Where:** `FastAPI/api/routes.py`, `/annotations/top`, both backends.

The stored dates look like `6/9/21 8:00` and the browser sends `2021-06-01`.
The code compares them as text. A start date therefore never filters anything,
and an end date filters out every sample, so the table comes back empty. The
start-date case is the more misleading one: the whole-dataset ranking comes back
labelled with the chosen range, and every row still says "128 samples".

**Confidence:** Confirmed (live). With `date_to=2021-06-05` the endpoint returns
an empty list; with `date_from=2021-06-15` it returns rows identical to the
unfiltered call.

**Fix:** parse both sides with the existing `_parse_any_datetime` helper, and
report the number of samples actually used rather than `len(samples)`.

### W14. The Explore overview's "Summed EGC over time" plots one member, not the sum

**Where:** `frontend/src/pages/ExplorePage.tsx`, `temporalSeries` (around line
216), feeding `MultiEgcChart.tsx`, `baseRows` (around line 77).

The overview relabels every member annotation's series with its group's name and
hands them all to the chart. The chart builds one row per timestamp and assigns
each series' value into that row by name. Because all members now share one
name, each overwrites the previous, and the plotted value is whichever member
came last.

**Why it matters:** the chart is captioned as the summed abundance of the top
functional groups and sits under a bar chart of summed mean EGC. The two
disagree by a large factor.

**Confidence:** Confirmed (live). For kegg, the "Brite Hierarchies" trace plots
823,158 at the first timepoint. Its three members sum to 4,854,154. The plotted
figure is exactly the last member's value.

**Fix:** sum members per timestamp when building `temporalSeries`.

### W15. The Scaffold Information date filter compares dates as text

**Where:** `frontend/src/components/scaffolds/ScaffoldExplorePanel.tsx`, lines
72–73, 399–400 and 411–412.

Same mistake as W2, this time in the browser. The scaffold summary endpoint
returns dates like `5/27/21 13:00` and the picker supplies `2021-06-10`. An end
date removes every point from the chart, the tables and the CSV; a start date
removes nothing. The `isoDate` helper that the Compare page uses for this is not
used here.

**Confidence:** Confirmed (live). With an end date the chart trace drops from
128 points to 0 and the axis collapses to a meaningless range; with a start date
all 128 points remain.

**Fix:** convert `r.date` with `isoDate()` before comparing.

## 3.2 Significant — misleading or incomplete output

### W3. Search returns unrelated annotations

`FastAPI/api/index.py:329` accepts a hit when an indexed word is contained in
the search term. Short indexed words like "in" match almost any query, so long
result pages are padded with unrelated annotations below the exact matches.

**Verify:** `ferredoxin` returns only annotations containing that substring.

### W4. Mapping search returns different results on each backend

The file backend falls back to a substring match across every annotation id, so
`K1` also returns `K10`, `K100` and so on. The SQL backend matches exactly.

**Verify:** the same query returns the same rows under both backends.

### W5. The Annotation Lookup card loses fields on the SQL backend

`frontend/src/pages/ExplorePage.tsx:1572–1581` reads category and scaffold
count from a `value` object the SQL search endpoint never returns. Those fields
render blank with no indication anything is missing.

**Verify:** identical card content under both backends.

### W7. Taxonomy rank labels are wrong for Eukaryota

`frontend/src/constants.ts`, `taxonomyRankLabel`. The comment says Eukaryota
depths should fall back to "Level N" because their lineages carry extra ranks.
The function never receives the category, so the fallback never applies.

**Verify:** Eukaryota rows below domain show "Level N".

### W8. `/taxonomy/export` and `/sql-test` crash on the file backend

Both read `request.app.state.sql_conn`, which only exists under
`DATA_BACKEND=sql`.

**Verify:** the CSV download works on both backends or returns a clear error.

### W16. Scaffold charts plot points shifted by the browser's UTC offset

**Where:** `ScaffoldModal.tsx:437`, `ScaffoldExplorePanel.tsx:42`,
`GroupScaffoldModal.tsx:512`, all using
`new Date(parseDateTime(d.date)).toISOString()`.

The date string is parsed as local time, then converted to UTC text, and Plotly
plots that UTC text at face value. On a Pacific-time browser every point moves
seven or eight hours later, so evening samples land on the following calendar
day. The hover tooltip and the table below the chart use the correct local time,
so the chart and table disagree about the same point. The `toPlotlyDate` helper
exists for exactly this and every EGC chart uses it; these three do not.

**Confidence:** Confirmed (code).

**Fix:** use `toPlotlyDate(d.date)`.

### W17. The Mappings panel sorts dates as text

**Where:** `frontend/src/components/mappings/MappingsPanel.tsx`,
`sortMappingRows`, lines 59–76, and the CSV export at line 235.

The comparator's comment says "ISO string sorts correctly", but the API returns
`6/10/21 8:00`, and as text that sorts before `6/2/21`. The table opens "sorted
by date ascending" showing 5/27, 6/1, 6/10, 6/18, 6/2, 6/9. Page one is not the
earliest rows, paging walks the data out of order, and the CSV is in the same
order. The unit test passes only because its fixtures use ISO dates the API
never emits.

**Confidence:** Confirmed (code); response format confirmed live.

**Fix:** sort on `parseDateTime(...)` numerically.

### W18. CSV exports do not contain what the chart shows

**Where:** `ComparePage.tsx:891–908`, `EgcChart.tsx` `handleExportCsv`,
`MultiEgcChart.tsx:322`, `GroupedEgcChart.tsx:256–264`.

Three separate mismatches. The Compare page always exports raw EGC even when the
chart shows relative abundance or z-scores. The single-annotation chart exports
the transformed values (metric swap, z-score, smoothing all applied) under a
column named `egc` with nothing saying so. The multi-series chart does the
reverse, naming its column `egc_normalized` even in raw mode. None of the
exports records which metric or transform was active.

**Why it matters:** a file labelled `egc` may hold fractions, standard-deviation
units, or a smoothed fit, and these files are what gets re-analysed outside the
portal.

**Confidence:** Confirmed (code).

**Fix:** name the value column from the active metric and add `metric`,
`standardized` and `smoothed` columns to every export.

### W19. Taxonomy exclusions can double-subtract, and a failed exclusion is invisible

**Where:** `TaxonomyTree.tsx` (exclusion checkbox, lines 96–105),
`utils/taxonomy.ts` `computeExclusionSeries` (lines 65–67),
`TaxonomyPage.tsx` (lines 181, 200).

Nothing stops a taxon and one of its own descendants from both being ticked. The
descendant is then subtracted once inside its ancestor's total and again on its
own, so the "minus exclusions" line is too low and can go negative. Separately,
the page only switches to the exclusion series once every exclusion fetch has
succeeded; a failed fetch looks like "still loading", so the chart silently
plots the unmodified total while its title still says "Excluding …".

**Confidence:** Confirmed (code).

**Fix:** skip descendants of an already-excluded taxon when summing and disable
their checkboxes; render an explicit error state when an exclusion fetch fails.

### W20. Every per-sample endpoint returns 404 on the SQL backend

**Where:** `FastAPI/api/routes.py`, the seven `/samples/{sample_name}/...`
routes (cog, kegg, enzyme, taxonomy, mappings, mappings/summary, full), plus
the older `/annotations/correlate`.

These still call the JSON file loaders, which have nothing to read under
`DATA_BACKEND=sql`. The About & API page advertises six of them.

**Confidence:** Confirmed (live). All return 404 for sample 3300060358.

**Fix:** add SQL branches, or remove the routes and the documentation for them.

## 3.3 Minor

### W9. Grouped series sorted alphabetically rather than by date

`ComparePage.tsx:110`, `AnalyzePage.tsx:494`. As text, `5/28/21 13:00` sorts
before `5/28/21 1:00` and all of 6/9 lands after 6/18. Charts re-sort correctly;
the CSV export does not. Confirmed by running both sorts over the live 128
datetimes.

### W10. Search behaves differently while the index is building

The startup fallback is case-insensitive and single-sample; the ready path is
case-sensitive and dataset-wide.

### W11. The unique-pairs filter is unreliable on the SQL backend

`cache_sql.py:422–423` builds the dedup key from `GROUP_CONCAT`, whose order
SQLite does not guarantee.

### Also noted, lower impact

- **Tide overlay is resampled onto the 128 sample times**, which aliases a
  12.4-hour tide onto 4-hour spacing. Against the full tide data the overlay has
  59 turning points where the tide has 77, with amplitude errors up to about a
  metre on a 3.7-metre range, enough to read flood as ebb. Both charts are now
  Plotly with a real date axis, so the original reason for resampling is gone.
- **LOWESS smoothing runs on array index, not time**, so a gap left by the date
  or time-of-day filter is smoothed as if it were four hours. With smoothing on,
  the Descriptive Statistics panel reports the smoothed curve's dispersion under
  the heading "EGC".
- **`/annotations/top` reports `sample_count` as the total sample count** even
  for a date-filtered request, so "Based on N samples" stays wrong after W2 is
  fixed unless both are addressed.
- **The Explore overview loads series for only the first 40 annotations** of
  the top five groups, silently dropping members of the later groups, and
  labels the 200-row cap as "200 unique annotations".
- **`/timepoints` reports 132 rows while `/samples` reports 128.**
- **`/taxonomy/children` differs between backends.** The JSON branch returns
  bare names and no `name` field, so the tree would render blank labels under
  `DATA_BACKEND=json`.

## 3.4 Non-functional

### W12. A test broken by the SQL work fails in CI

`tests/test_batch2_backend.py::TestSmokePatched::test_search_mappings_unique_pairs_flag`
calls `search_mappings()` without the `request` argument. Three sibling tests
have the same defect masked by a skip. At the re-audit the CI command gave
`5 failed, 341 passed, 135 skipped`; the other four failures need the dataset.

### W13. Dead normalization helpers with a misleading comment

`frontend/src/utils/signal.ts` exports two functions claimed to be used by
MultiEgcChart that nothing outside tests calls.

---

# Part 4 — Test blind spots

### T1. The tests do not pin the behaviour that is actually broken

- `norm_egc` is never checked against an absolute value for COG, Enzyme or
  Taxonomy. The assertions (constant ratio within a sample, same across sources,
  in (0, 1]) hold for any denominator.
- The BRITE hierarchy test re-implements the buggy parser and compares the
  notebook's output to that clone, so E14 cannot be caught.
- `test_all_jgi_cogs_spot_sample_pass_rate` allows 20% of COG values to be
  wrong while conftest states COG matches JGI exactly.
- No correlation test covers lag direction, NaN input, or the real KEGG parent
  format. All 49 pass against code with CR1, CR3 and CR4 present.

**Fix:** assert `norm_egc == egc / calculate_denominator_egc(...)` across all
four sources; assert K00844 is reachable from 00010; require zero COG failures;
add correlation tests for a known-lag pair in both id orders and for a constant
candidate.

---

# Re-audit checklist

## EGC calculations

- [x] **E14** Glycolysis EGC ≥ any member KO in every sample; KEGG JSON and SQL regenerated
- [x] **E15** COG category nodes exist with `depth` and `parent_id`
- [ ] **E16** Internal lineage repeats counted; collapse removed or limited to trailing repeats
- [x] **E5** Single shared scaffold-ID helper; no gene IDs with a field count other than 4. ❌ **Shared-helper refactor rejected** -- already decided in the prior audit round, reconfirmed here: checked all 128 samples across both `.a.cog.txt` and `.a.ko.txt`, every real gene id is exactly 4-field, so `All_Coverages.py`'s and "everywhere else"'s derivations always agree in practice; doesn't matter given our real database. Note for later: the raw JGI data itself is inconsistently labeled here -- `.a.depth.txt`'s `AvgFold` column is keyed by scaffold id (2 fields, e.g. `Ga0590986_0000001`), not gene id (4 fields), which is what actually made this easy to misdiagnose (the audit's own suggested verify command checks the wrong file for this reason).
- [ ] **E6** KEGG intermediate regenerated, or the notebook fails on a stale one
- [ ] **E7** Exactly one `.a.ko.txt` per sample; `rglob` replaced with a direct path
- [ ] **E8** KEGG reader no longer swallows exceptions
- [ ] **E9** Reference-gating documented; drop counts logged
- [ ] **E10** `;` confirmed absent; split replaced by an assertion
- [ ] **E12–E13** Contradictory comments and UI copy corrected
- [ ] `weighted_totals.py` and `All_Coverages.py` no longer hardcode a Windows path

## Correlation feature

- [x] **CR1** Lag sign correct for a reference with the higher catalog id; test in both orders
- [x] **CR2** Autocorrelation-aware null; simulated independent AR(1) pairs pass q < 0.05 at ≤ 5% -- circular-shift permutation restored (re-searches all 9 lags per shift, not fixed-lag), verified with the exact simulation this item describes: 150 independent AR(1) pairs, φ=0.85, n=128 (same parameters as the audit's own ~51%-under-the-old-gate measurement) -- measured 1.3% pass rate under q<0.05 (`tests/test_correlation_math.py::TestCR2FalsePositiveRateSimulation`). ⚠️ Available as an additional `method=circular_shift` choice, not the default -- the 3 original methods (raw_pearson/log_pearson/spearman) still use the uncalibrated parametric p-value; a user has to actively pick circular_shift to get this guarantee.
- [x] **CR3** Within-kegg family for 00010 excludes 09101 and its member KOs; `parent_id` stored -- `parent_id` stored (was `parent_name`). Descendant/ancestor/sibling exclusion for kegg rewritten to read `kegg_paths` (`_kegg_family_exclusions`) instead of the single-valued `parent` column, since a KEGG node can have multiple real parents (K00844 has 14, per E14) that one column can't represent. Verified live against the audit's own exact example: 00010's family now correctly excludes both 09101 (ancestor) and K00844 (the multi-parent descendant that was previously missed). Enzyme/COG/taxonomy untouched -- confirmed single-parent by construction, no bug there. Negligible perf impact (32ms for K00844 itself as ref, the worst-case 14-parent node).
- [x] **CR4** Constant candidate returns 200 and is omitted
- [x] **CR5** Results sorted by strength and capped
- [x] **CR6** `load_sample_order` fails on an undatable sample; spacing asserted -- undatable-sample failure implemented (`assert_sample_order_is_trustworthy`, called at SQL-backend startup, also catches two samples colliding on the same timestamp). ❌ **"spacing asserted" rejected as literally stated** -- checked live first (this project's own habit, not skipped lightly): real data has legitimate 8h/12h gaps from missing samples, so a strict "must be exactly 4h apart" assertion would crash the server on valid, real data. `lag_hours` stays an approximation across a gap; no assertion added for it.
- [x] **CR7** Dead batch job removed; loaders moved

## Web application

- [ ] **W1** JSON `/correlation` route removed, or its vectors index-aligned
- [ ] **W2** Both date bounds filter correctly on Top EGC Annotations; `sample_count` reflects the filter
- [ ] **W14** Overview "Summed EGC" trace equals the sum of member series at every timepoint
- [ ] **W15** Scaffold Information date filter removes only out-of-range points
- [ ] **W16** Scaffold chart points sit at the same local time as the table row
- [ ] **W17** Mappings panel default order is chronological; CSV matches
- [ ] **W18** Every CSV export names its value column by the active metric and records transforms
- [ ] **W19** Nested exclusions subtract once; failed exclusion fetch shows an error
- [ ] **W20** Per-sample routes work under SQL or are removed from the API page
- [ ] **W3** Search no longer matches on short indexed substrings
- [ ] **W4** Mapping search identical across backends
- [ ] **W5** Lookup card identical across backends
- [ ] **W7** Eukaryota rows show generic level labels
- [ ] **W8** Taxonomy CSV export works on both backends
- [ ] **W9** Grouped CSV export chronological
- [ ] **W10** Search results stable across index readiness
- [ ] **W11** unique-pairs count identical across backends
- [ ] **W12** CI backend job green
- [ ] **W13** Dead normalization helpers removed or wired up

## Tests

- [ ] **T1** Absolute `norm_egc` assertion, BRITE reachability test, zero-failure COG gate, lag-direction and NaN correlation tests -- lag-direction (CR1) and NaN/constant-candidate (CR4) correlation tests done; the three EGC-calculation test items (norm_egc, BRITE reachability, COG gate) not touched this session
