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

**Fixed:** removed `correlation.router` (both mounts) and the now-unused
`correlation` import from `main.py`; the module itself is untouched since its
functions are still called directly, unaffected, by existing tests. See
checklist below for verification.

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

**Fixed:** added `index.is_within_date_range()`, which parses both the
sample's raw datetime and the `date_from`/`date_to` bounds via
`_parse_any_datetime` (extended with a `"%Y-%m-%d"` format, since
`<input type="date">` sends a bare date with no time) and compares them as
real datetimes, not text -- `date_from` inclusive from 00:00 of that day,
`date_to` inclusive through the end of that day. Both backend branches in
`/annotations/top` (`FastAPI/api/routes.py`) now use it, and both now report
`sample_count` as the actual number of samples that passed the filter
(cached alongside the ranked results as `(data, count)`) instead of
`len(samples)`/`len(all samples)`. Verified live: `date_to=2021-06-05` now
returns 57/128 samples (was an empty list); `date_from=2021-06-15` now
returns 21/128 (was silently identical to the unfiltered 128); a narrow
`2021-05-27`..`2021-05-28` window returns exactly 9, independently
cross-checked against raw `TIMEPOINTS` by direct computation.

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

**Fixed:** extracted the summing into a new pure function
`sumMembersByTimestamp()` (`frontend/src/utils/stats.ts`), which each group's
member EGC/norm_egc are summed into per timestamp before being handed to
`MultiEgcChart` -- so `MultiEgcChart`'s existing one-point-per-(annotationId,
datetime) row builder is no longer handed multiple raw points that silently
overwrite each other. `ExplorePage.tsx`'s `temporalSeries` now calls it
instead of flat-mapping raw per-member points. Verified with the audit's own
real numbers as a regression test (3 members: 2,000,000 + 2,030,996 + 823,158
= 4,854,154, not the last member's 823,158) plus 5 more unit tests
(`frontend/src/tests/utils.pure.test.ts::sumMembersByTimestamp` -- norm_egc
summed independently, distinct timestamps kept separate, a missing/failed
member doesn't crash others, empty input, norm_egc stays `null` not `0` when
no member reports one). Caught and fixed an unrelated regression along the
way: an earlier About-page edit this session (documenting the real
correlation pipeline) had renamed a heading to "Correlation (Find
Correlates)", which collided with `AnalyzePage`'s actual "Find Correlates"
button text under `getByText(/Find Correlates/i)` in
`analyze-page.component.test.tsx` (ambiguous multi-match), silently breaking
11 of that file's 108 tests; reworded to "Correlation (Correlates panel)".
Full frontend suite (902 tests) and `tsc -b --force` both clean after.

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

**Fixed:** all 3 spots now compare `isoDate(r.date)` against `dateFrom`/
`dateTo` instead of the raw string, matching the pattern `MultiEgcChart.tsx`
already used correctly. Also simplified: the split-mode chart branch had its
own inline duplicate of `filterSummaryForChart`'s filter+sort (now just
calls it), and the aggregated-mode dateMap builder was extracted into a new
exported `buildAggregatedChartRows()` -- both are now exported for testing
instead of living only inside the component. This mattered in practice: the
existing `tests/scaffold-explore.unit.test.ts` had its own local
reimplementation of this exact logic with only ISO-format fixtures
("2021-05-10 08:00"), which compare correctly as plain text and so never
exercised the actual bug (the real API returns unpadded "M/D/YY H:MM") --
that gap is exactly why W15 went undetected. Switched the test file to
import the real functions and added 6 new regression tests using the real
raw format (`RAW_FORMAT_SUMMARY`), verified to actually fail against the
pre-fix code (24 failures reproduced by temporarily reverting the component
change). Full frontend suite (908 tests) and `tsc -b --force` clean after.

## 3.2 Significant — misleading or incomplete output

### W3. Search returns unrelated annotations

`FastAPI/api/index.py:329` accepts a hit when an indexed word is contained in
the search term. Short indexed words like "in" match almost any query, so long
result pages are padded with unrelated annotations below the exact matches.

**Verify:** `ferredoxin` returns only annotations containing that substring.

**Fixed:** removed the `key in token` direction of the substring match
entirely (`search_index()`, `FastAPI/api/index.py`) -- a query only matches
an indexed word that CONTAINS the query as a substring, never the reverse.
A length threshold on the indexed word was tried first and rejected: even
a 3+ char indexed word can coincidentally collide (real data: "ferredoxin"
itself contains the real English substrings "red" and "err" --
fer-RED-oxin, f-ERR-edoxin -- so a length guard alone doesn't get to zero
false positives). Verified against the full real 128-sample index: searching
"ferredoxin" went from 113 false-positive taxonomy matches (and 0 genuine
ones even checked) to 0 false positives / 29 genuine cog matches; a
short-query case ("iro" still finding "iron") confirmed the kept direction
still works. New tests in `tests/test_unit_backend.py::TestSearchIndex`
reproduce the exact "f"/"red"/"err" collisions with a synthetic index,
confirmed to fail against the pre-fix code.

### W4. Mapping search returns different results on each backend

The file backend falls back to a substring match across every annotation id, so
`K1` also returns `K10`, `K100` and so on. The SQL backend matches exactly.

**Verify:** the same query returns the same rows under both backends.

**Investigated, not fixed (❌ deliberate, JSON backend is being retired):** confirmed
live -- `annotation_id=K1` on the JSON backend returns 282,671 rows via the
substring fallback (`FastAPI/api/routes.py`, `search_mappings`'s
`DATA_BACKEND == 'json'` branch, ~line 356). Root cause turned out deeper
than the audit's description: the JSON mapping index (`build_mapping_index`)
stores raw TSV values, which are prefixed (`"KO:K02112"`, `"EC:7.1.2.2"`),
while the catalog/frontend always pass the bare id (`"K02112"`). The exact
lookup therefore *never* succeeds for kegg -- every kegg mapping search
already goes through the broken substring fallback today, not just
edge cases; it happens to look like it mostly works only because the bare
id is a literal substring of its own prefixed form. Enzyme has the same
prefix mismatch, plus a second bug: one gene can carry multiple
comma-separated EC ids in one TSV field, and the whole comma-joined string
is indexed as a single key, so a gene with 2+ enzyme annotations is
unreachable by searching either id alone. COG is unaffected (its raw and
catalog ids already match exactly). Taxonomy needs exact-or-descendant-prefix
matching by design (searching "Bacteria" should also return every
descendant), which the SQL backend already does correctly and a blind
substring match would not replicate. A real fix therefore isn't "remove the
fallback" -- that would silently zero out kegg and enzyme mapping search
entirely, a worse regression than today's over-matching -- it would require
normalizing the kegg/enzyme prefixes, splitting enzyme's multi-value field,
and giving taxonomy real prefix semantics, i.e. re-deriving most of what
`get_mappings_sql` already does correctly. Per user: the JSON backend is
slated for eventual removal, so this is being left as-is rather than
invested in.

### W5. The Annotation Lookup card loses fields on the SQL backend

`frontend/src/pages/ExplorePage.tsx:1572–1581` reads category and scaffold
count from a `value` object the SQL search endpoint never returns. Those fields
render blank with no indication anything is missing.

**Verify:** identical card content under both backends.

**Fixed:** `get_search_annotations()` (`FastAPI/api/cache_sql.py`) now
returns `category` and `scaffold_count` as top-level fields, via correlated
subqueries against `annotation_series` (the per-sample table -- these two
fields don't exist on `annotation_catalog`, the pre-aggregated table the
rest of the query reads from). `category` is exact: confirmed live it's
identical across every sample for a given annotation (0 exceptions across
the whole table), so an arbitrary single-row pick is correct, not
approximate. `scaffold_count` genuinely varies by sample, so this returns a
real count from *a* sample (unordered `LIMIT 1`), not necessarily the same
"earliest sample" the JSON backend's `value.scaffolds` happened to reflect
-- an `ORDER BY sample` version was tried first and rejected: it measured
in the minutes for a full-catalog scan (no index supports per-group sample
ordering) vs ~8s unordered / ~0.7s for a realistic filtered query; the UI
tooltip copy was adjusted to stop promising "earliest" specifically.
`depth` needed no backend change -- it was already returned top-level, the
frontend just wasn't reading it from there. Frontend: added
`resolveLookupCategory`/`resolveLookupScaffoldCount`/`resolveLookupDepth`
(`frontend/src/utils/stats.ts`) that read the top-level field when present
and fall back to the nested `value.*` shape otherwise, so the same UI code
works on whichever backend answered -- deliberately did NOT change the JSON
backend's response shape to match, per user: not worth investing in code
that's being retired. Verified live end-to-end (SQL response now includes
`"category": "Energy production and conversion", "scaffold_count": 169` for
COG0055) plus 5 new SQL-layer tests (`tests/sql/test_search_annotations_sql.py`,
including a timing regression guard for the rejected ORDER BY approach) and
12 new frontend unit tests covering both response shapes and the
top-level-wins-when-both-present precedence
(`frontend/src/tests/lookup-detail.unit.test.ts`).

### W7. Taxonomy rank labels are wrong for Eukaryota

`frontend/src/constants.ts`, `taxonomyRankLabel`. The comment says Eukaryota
depths should fall back to "Level N" because their lineages carry extra ranks.
The function never receives the category, so the fallback never applies.

**Verify:** Eukaryota rows below domain show "Level N".

**Fixed:** `taxonomyRankLabel(depth, domain?)` now takes an optional domain
and only applies the fixed ladder when `domain !== 'Eukaryota'`. Domain is
derived at each call site either from an already-available `category`
field (`TaxonomyTreeNode`/`TaxonomyChildNode`) or via a new
`taxonomyDomainFromId(annotationId)` helper (`utils/taxonomy.ts`) -- a
taxonomy annotation_id IS its full lineage-prefix, so its first segment is
always the domain root, no extra data needed. Updated the 7 call sites that
render ONE annotation's rank (`TaxonomyTree.tsx`, `TaxonomyBrowseTree.tsx`,
`EgcChart.tsx`, `ExplorePage.tsx`'s lookup detail card, `TaxonomyPage.tsx`,
`CorrelatesPanel.tsx`, `LeftResultList.tsx`); left the 4 depth-only
rank-*filter*-pill call sites unchanged with a comment explaining why --
those aggregate across potentially many taxa of different domains at once,
so there's no single correct domain to resolve for a bare "depth 3" pill.
Found and fixed the same bug in a second place while in the file:
`expandParentLabel`'s taxonomy branch (also `constants.ts`) had the
identical `TAXONOMY_RANK_NAMES[segments.length]` with no domain check.
Caught and fixed a test that had pinned the bug as intended behavior:
`taxonomy-tree.component.test.tsx` asserted Eukaryota depth 2 renders
"Phylum" under the title "uses the same rank ladder for Eukaryota as every
other domain" -- rewrote to assert the correct "Level 2". Verified the new
tests fail against the pre-fix code (confirmed by temporarily reverting).
27 new unit tests (`taxonomy-utils.unit.test.ts`: `taxonomyDomainFromId`,
`taxonomyRankLabel`, `expandParentLabel`'s taxonomy branch) plus the fixed
component test.

### W8. `/taxonomy/export` and `/sql-test` crash on the file backend

Both read `request.app.state.sql_conn`, which only exists under
`DATA_BACKEND=sql`.

**Verify:** the CSV download works on both backends or returns a clear error.

**Investigated, not fixed (❌ deliberate, JSON backend is being retired):**
confirmed by code reading -- `/taxonomy/export` (`FastAPI/api/routes.py`)
does `db = request.app.state.sql_conn` unconditionally, with no `DATA_BACKEND`
branch at all; a JSON-backend implementation was never written, not a
regression. `/sql-test` is a connectivity-check debug endpoint whose entire
purpose is to test the SQL connection -- failing under `DATA_BACKEND=json`
(no SQL connection to test) is the intended signal, not a bug; the test
suite itself relies on this exact behavior to detect which backend is live
(`_sql_backend_active()` in several `tests/sql/*_route.py` files checks
`/sql-test`'s status code). Both work correctly under `DATA_BACKEND=sql`,
the persisting backend. Per user: JSON backend is being retired, not worth
building a parallel implementation for -- left as-is.

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

**Fixed:** replaced `new Date(parseDateTime(d.date)).toISOString()` with
`toPlotlyDate(parseDateTime(d.date))` in all 3 files. Confirmed the bug was
real on this machine (system timezone is America/Los_Angeles, i.e. exactly
the Pacific-time case the audit describes): the old expression rendered
`6/9/21 21:00` as `2021-06-10T04:00:00.000Z` -- pushed onto the following
calendar day. Added 6 new tests (`tests/utils.pure.test.ts::toPlotlyDate`)
that check the fixed output against `fmtDate`/`fmtTime` (both already
correct, string-parsed with no timezone conversion) component-by-component
-- a comparison that holds regardless of what timezone the tests happen to
run in, unlike testing against `.toISOString()` directly. Full frontend
suite (939 tests) and `tsc -b --force` clean after.

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

**Fixed:** `sortMappingRows()` (`frontend/src/components/mappings/MappingsPanel.tsx`)
now compares `parseDateTime(...)` numerically for the `date`/`time` sort
columns instead of `localeCompare` on the raw string; every other column
(taxonomy/kegg_id/enzyme/cog_id) is untouched. The CSV export needed no
separate fix -- it already maps over `sortedRows`, this same function's
output, so fixing the sort fixed the CSV order for free (confirmed with a
dedicated test). Reproduced the audit's exact example as a regression test
using the real raw format ("6/10/21 8:00", not the fixture suite's ISO
dates that never triggered the bug) -- confirmed to fail against the pre-fix
code (4 failures, matching the exact wrong order the audit describes: 5/27,
6/1, 6/10, 6/18, 6/2, 6/9 instead of true chronological order). 4 new tests
in `tests/mappings-panel.unit.test.ts`.

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

**Fixed:** all 4 sites. `EgcChart.tsx` and `GroupedEgcChart.tsx` (both
hardcoded `egc:`) and `MultiEgcChart.tsx` (hardcoded `egc_normalized:` even
in raw mode) now use a computed `[metric]:` key and always include
`metric`/`standardized`/`smoothed` columns (`MultiEgcChart` already had
`metric`/`standardized`; `smoothed` was missing entirely there too).
`ComparePage.tsx`'s page-level CSV button was removed rather than fixed --
it always re-derived raw EGC from scratch via its own `extractEgc()` call,
with no access to `MultiEgcChart`'s internal metric/standardize/smoothed
state (that chart isn't a `forwardRef` and doesn't expose its state to the
parent), so it could only ever be wrong whenever the chart wasn't in plain
raw-EGC mode; `MultiEgcChart` renders directly below it with its own
(now-correct) `↓ CSV` button covering the same data properly, making the
page-level one purely redundant on top of being broken. Extracted each
chart's row-building logic into an exported pure function
(`buildEgcTimeseriesCsvRows`, `buildMultiEgcCsvRows`, `buildGroupedEgcCsvRows`)
so it's directly testable, matching the pattern already used for
`buildMappingCsvRow`. Fixed a stale test in `compare-page.component.test.tsx`
that referenced the removed button by name/comment (its assertions still
happened to pass against the remaining button, but the description was
now wrong). 20 new tests in `tests/egc-csv-export.unit.test.ts`.

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

**Fixed, both parts.** First confirmed the premise live: a domain's egc
exactly equals the sum of its direct child phyla's egc (Bacteria:
13,121,942.0 both ways, sample 3300060358) -- taxonomy egc values are
hierarchical rollups, so excluding an ancestor already zeroes out
everything under it.

*Double-subtraction:* added `isCoveredByAnotherExclusion`/
`filterRedundantExclusions` (`utils/taxonomy.ts`) -- a taxonomy id is its
own full lineage-prefix, so "is X a descendant of Y" is a `startsWith(Y +
';')` check (segment-boundary safe: "Proteobacteria2" isn't treated as a
descendant of "Proteobacteria"). `computeExclusionSeries` now takes the
excluded ids alongside their series and filters out any id covered by
another excluded id before subtracting -- verified the pre-fix code
actually produces the wrong number on the audit's own scenario
(1000-300-120=580 instead of the correct 1000-300=700, since the 120 was
already inside the 300). `TaxonomyTree.tsx` also disables the checkbox of
any node covered by an existing exclusion (with an explanatory tooltip),
covering the actual gap: the existing "can't expand into an excluded
node's children" guard only blocks *future* navigation into a newly-excluded
node -- it does nothing for a descendant that was already visible/expanded
from *before* its ancestor got excluded, which was the real path to the
double-subtraction. The `computeExclusionSeries` fix guarantees correctness
even if that state occurs anyway.

*Invisible failure:* `TaxonomyPage.tsx` now tracks exclusion fetch status
as three groups (`excludedLoaded`/`excludedFailed`/`excludedPending`)
instead of one boolean that conflated "loading" and "error" into the same
"not ready" bucket. A failure now renders an explicit error banner naming
which exclusion(s) failed, with a button to remove them, and the chart
title (`computeChartTitle`) only lists exclusions that actually loaded
-- it no longer claims an exclusion is applied when its fetch failed.

19 new tests across `taxonomy-utils.unit.test.ts` (the double-subtraction
math, `isCoveredByAnotherExclusion`, `filterRedundantExclusions`),
`taxonomy-tree.component.test.tsx` (checkbox disabled for a covered
descendant, still enabled for an unrelated sibling), and
`taxonomy-page.component.test.tsx` (error banner shown/not shown,
a successfully-loaded exclusion still applies when a different one failed)
-- confirmed to fail against the pre-fix code by temporarily reverting.

### W20. Every per-sample endpoint returns 404 on the SQL backend

**Where:** `FastAPI/api/routes.py`, the seven `/samples/{sample_name}/...`
routes (cog, kegg, enzyme, taxonomy, mappings, mappings/summary, full), plus
the older `/annotations/correlate`.

These still call the JSON file loaders, which have nothing to read under
`DATA_BACKEND=sql`. The About & API page advertises six of them.

**Confidence:** Confirmed (live). All return 404 for sample 3300060358.

**Fix:** add SQL branches, or remove the routes and the documentation for them.

**Fixed (removed).** Investigated *why* they 404 before picking a fix:
`load_cog`/`load_kegg`/etc. read directly from JSON files on disk,
completely independent of `DATA_BACKEND` -- they work fine locally
(confirmed live: `load_cog('3300060358')` returns 4538 real entries on this
machine). The 404 the audit found live is a production-deployment fact, not
a code bug: the full JSON dataset is 55GB+ vs the SQL database's 87MB (see
[[project_mongodb_integration]] memory), so it was never a candidate for
shipping to the production server -- any route still depending on it can
only ever work in a full local dev checkout. Confirmed the frontend never
calls any of these 7 routes (or the related, same-defect
`/samples/{sample_name}/search/annotations`, an 8th route with the
identical bug that the audit didn't list but I found while in the file) --
grepped for every call pattern, zero matches outside the About page's API
reference table and this same dead code's own tests. Removed all 8 routes,
the now-orphaned `_annotation_endpoint`/`paginate_dict` helpers, their
stale API-reference entries in `AboutPage.tsx`, and their JSON-only-backend
tests in `test_unit_backend.py` (which passed by construction -- they used
`patched_client`'s JSON-mocked fixture, so they never exercised the real
SQL-backend gap the audit found). Confirmed via `main.app.routes`
inspection that all 8 paths are gone and `/samples` itself still works.
Full backend suite still at the same known 12 pre-existing failures
(unrelated `DATA_BACKEND=sql`/`patched_client` gap) both before and after
-- 317 passed either way, no regressions from the removal.

## 3.3 Minor

### W9. Grouped series sorted alphabetically rather than by date

`ComparePage.tsx:110`, `AnalyzePage.tsx:494`. As text, `5/28/21 13:00` sorts
before `5/28/21 1:00` and all of 6/9 lands after 6/18. Charts re-sort correctly;
the CSV export does not. Confirmed by running both sorts over the live 128
datetimes.

**Fixed.** Both were separate, near-identical copies of the same
egc/norm_egc-summing-per-datetime logic, each with the exact same bug
independently. Rather than patch the sort key in two places (and leave two
copies of the same logic free to diverge again), unified both to call the
one shared `sumMembersByTimestamp` (`utils/stats.ts`, originally added for
W14), which now sorts its own output by `parseDateTime` before returning --
so the guarantee lives at the one place the data is produced, not
re-derived by every current or future consumer. `AnalyzePage.tsx`'s
version needed `annotation_id` and display `name` to differ (`c.key` vs
`c.label`), which the shared function's single `groupLabel` param doesn't
support, so that one field is overridden on the returned items afterward.
Verified downstream consumers (`MultiEgcChart`) already defensively
re-sort by real timestamp regardless, so this wasn't visibly wrong in the
chart itself -- but the CSV export (fixed for W18) reads the row order
this function returns, so the guarantee needed to be real, not just
incidentally masked. 2 new regression tests in
`tests/utils.pure.test.ts::sumMembersByTimestamp` using the audit's own
scrambled real-format dates, confirmed to fail with a plain string compare.

### W10. Search behaves differently while the index is building

The startup fallback is case-insensitive and single-sample; the ready path is
case-sensitive and dataset-wide.

**Investigated, not fixed (❌ deliberate, JSON backend is being retired):**
confirmed a real gap, though narrower than described -- both paths' free-text
`q` search are already consistently case-insensitive (both lowercase the
query and the compared field). The actual difference is the strict
`annotation_id` exact-match parameter: the warmup scan
(`_search_annotations_scan` → `_search_dict_annotations`,
`FastAPI/api/routes.py`) does `.lower() == annotation_id.lower()`, while the
ready-index path (`search_annotations`'s `DATA_BACKEND=='json'` branch) does
a case-sensitive dict-key lookup (`annotation_id in _ANN_META[src]`) --
`annotation_id=cog0001` would find `COG0001` during warmup but not once the
index is ready. Also confirmed "single-sample" doesn't describe the scan
fallback itself (`_search_annotations_scan` loops `get_all_sample_names()`,
every sample) -- likely a description mismatch in the original audit,
possibly conflated with the now-removed `/samples/{sample_name}/search/annotations`
(W20). This entire inconsistency is confined to `DATA_BACKEND=json`'s two
internal code paths; the SQL backend has no "warming up" concept at all --
one query path, always ready, so there's nothing to reconcile there. Per
user: JSON backend is being retired, not worth the investment -- left as-is.

### W11. The unique-pairs filter is unreliable on the SQL backend

`cache_sql.py:422–423` builds the dedup key from `GROUP_CONCAT`, whose order
SQLite does not guarantee.

**Fixed.** Added `_sort_group_concat()` (`FastAPI/api/cache_sql.py`) --
sorts the comma-separated `cog_id`/`enzyme` fields `get_mappings_sql`
returns, since SQLite's `GROUP_CONCAT(DISTINCT ...)` has no `ORDER BY`
support inside the aggregate the way some other SQL dialects allow, so two
mapping rows with the exact same set of ids could concatenate in a
different order depending on the query plan -- and `search_mappings`'
`unique_pairs` dedup key (`FastAPI/api/routes.py`) is built directly from
these fields, so an order difference on otherwise-identical values would
make it treat real duplicates as distinct and let them through. Honest
caveat: this specific real database's natural `GROUP_CONCAT` order already
happens to come back alphabetically sorted for every multi-value case
checked (confirmed live, e.g. COG1539's 3-value enzyme field) -- so the
"real data" regression tests pass with or without the fix and can't prove
the bug currently manifests in this exact SQLite version/query plan on
this exact data. The fix addresses the actual lack of a *guarantee* (which
is the audit's stated concern), not a currently-reproducible flip-flop;
the 5 direct unit tests against `_sort_group_concat` itself are what
actually pin the fix down. 7 new tests total in
`tests/sql/test_mappings_sql.py`, plus the existing live-route
`tests/sql/test_mappings_search_route.py` suite (6/6) still passing.

### Also noted, lower impact

- **Tide overlay is resampled onto the 128 sample times**, which aliases a
  12.4-hour tide onto 4-hour spacing. Against the full tide data the overlay has
  59 turning points where the tide has 77, with amplitude errors up to about a
  metre on a 3.7-metre range, enough to read flood as ebb. Both charts are now
  Plotly with a real date axis, so the original reason for resampling is gone.

  **Investigated, not fixed (❌ deliberate, for now).** Confirmed the premise:
  `alignTideToChartPoints`'s own docstring (`utils/solar.ts`) says the
  resampling is "required for Recharts to render both on one ComposedChart
  without a second, independent x scale" -- stale, since both charts moved
  to Plotly, which can plot the tide trace at its own native 6-minute
  resolution on the same continuous date x-axis without needing to share
  x-values with the sparse EGC points at all. A correct fix means
  restructuring the tide trace in all 3 chart components (`EgcChart.tsx`,
  `MultiEgcChart.tsx`, `GroupedEgcChart.tsx`) to plot the full tide dataset
  independently rather than resampled onto `pointsWithTide`. Left
  uninvestigated further and unfixed per user: this is a real but
  visual-only change (does the secondary y-axis/trace actually render
  correctly against a differently-shaped x-array) that can't be verified
  without opening a browser, unlike everything else fixed this session,
  which had a real-data or test-level way to confirm correctness.
- ~~**LOWESS smoothing runs on array index, not time**, so a gap left by the date
  or time-of-day filter is smoothed as if it were four hours.~~ **Fixed.**
  `applyLowess` (`frontend/src/utils/signal.ts`) now takes distance from each
  point's real `ts` (epoch ms) instead of its array index, and fits a
  regression centred on the query point (regressor `p.ts - pt.ts`) rather than
  raw epoch values, avoiding precision loss from squaring/differencing large
  epoch magnitudes. `EgcChart.tsx` and `GroupedEgcChart.tsx` already carried a
  real `ts` field on their point objects; `MultiEgcChart.tsx` needed one
  threaded through (`ChartRow._ts`). Regression tests added in
  `tests/utils.pure.test.ts` (`applyLowess` describe block): one proves two
  series with identical values/index positions but different timestamps now
  smooth differently, the other proves a 30-day real gap keeps two clusters
  from bleeding into each other's fit. Both verified to fail against the
  pre-fix code (temporarily reverted) before being marked done.
- ~~**`/annotations/top` reports `sample_count` as the total sample count** even
  for a date-filtered request, so "Based on N samples" stays wrong after W2 is
  fixed unless both are addressed.~~ **Resolved as part of the W2 fix** --
  `sample_count` now reflects `filtered_sample_count` (the actual number of
  samples that passed the date filter) on both backends, not `len(samples)`.
  Already covered by W2's own tests.
- ~~**The Explore overview loads series for only the first 40 annotations** of
  the top five groups, silently dropping members of the later groups, and
  labels the 200-row cap as "200 unique annotations".~~ **Fixed, both
  halves.** Found a second, related bug while investigating: the "showing
  first N" truncation warning checked `rows.length === 500`, but the actual
  fetch uses `limit=200` -- the check could never fire (200 ≠ 500), so a
  genuinely-truncated top-annotations list showed no indication of
  truncation at all. Fixed the mismatched number. Separately, added an
  explicit warning banner when the top-5-groups' combined member count
  exceeds the 40-annotation fetch cap (`ExplorePage.tsx`'s
  `DatasetOverviewPanel`), naming the true combined count so a group whose
  members got silently cut isn't just quietly undercounted. Exported
  `DatasetOverviewPanel` for direct component testing. 6 new tests
  (`tests/dataset-overview-panel.component.test.tsx`), confirmed 2 of them
  fail against the pre-fix code.
- ~~**`/timepoints` reports 132 rows while `/samples` reports 128.**~~
  **Fixed.** Confirmed live: 4 real-looking taxon_oids in
  `JGI_ID_Timepoints_128.csv` (plausible dates inside the sampling window)
  were never processed into mapping/annotation data on either backend.
  Added `_filter_timepoints_to_real_samples()` (`FastAPI/api/routes.py`),
  applied in `/timepoints` using whichever backend's own real sample list
  `/samples` already uses -- both endpoints now agree on 128 (verified
  live). Tested directly rather than via the HTTP layer, since the SQL
  branch needs `app.state.sql_conn`, which the `patched_client` test
  fixture doesn't set up (the same pre-existing gap already affecting
  other SQL-backed routes) -- 3 existing HTTP-level `/timepoints` tests
  now join that same known category (12 -> 15 total, all one root cause);
  6 new direct unit tests on the actual filtering logic bypass that gap
  entirely and are what really pin the fix down.
- ~~**`/taxonomy/children` differs between backends.** The JSON branch returns
  bare names and no `name` field, so the tree would render blank labels under
  `DATA_BACKEND=json`.~~ **Fixed.** Unlike the other JSON-backend items this
  session left alone, this one was a genuine one-line addition (not a
  from-scratch parallel implementation), so it was worth just fixing:
  `taxonomy_children`'s JSON branch (`FastAPI/api/routes.py`) now includes
  `"name": rec["annotation_id"].split(";")[-1]`, matching
  `get_taxonomy_children_sql`'s existing bare-last-segment convention.
  Tested directly (not via `patched_client`/HTTP, which runs against the
  real `DATA_BACKEND=sql` config and would hit the SQL branch, never
  reaching the JSON branch this is about) by monkeypatching
  `routes.DATA_BACKEND` to `'json'` and calling the route function
  directly. 3 new tests, confirmed to fail pre-fix (`KeyError: 'name'`).

## 3.4 Non-functional

### ~~W12. A test broken by the SQL work fails in CI~~ Fixed

`tests/test_batch2_backend.py::TestSmokePatched::test_search_mappings_unique_pairs_flag`
calls `search_mappings()` without the `request` argument. Three sibling tests
have the same defect masked by a skip. At the re-audit the CI command gave
`5 failed, 341 passed, 135 skipped`; the other four failures need the dataset.

**Fixed.** `search_mappings()` picked up a required `request: Request` param
during the SQL migration (used to reach `request.app.state.sql_conn`), but 6
call sites across `TestSmokePatched` and `TestMappingSearch` never passed one.
Added a minimal `_FakeRequest`/`sql_request` fixture (real `sqlite3` connection
via `api.db.connect_to_sql`, wrapped so `request.app.state.sql_conn` resolves)
and threaded it through all 6 call sites, not just the one CI reported —
the other 4, in `TestMappingSearch`, don't execute unless `_MAPPING_INDEX`
is warm (a JSON-backend-only artifact, populated only after the full
`warm_server` warmup fixture runs -- multiple minutes over the real 55GB+
JSON dataset). Verified: `TestSmokePatched`'s 2 previously-failing tests
pass (`TypeError: search_mappings() missing 1 required positional argument:
'request'` gone).

**Follow-up: actually ran `TestMappingSearch` against real data** (user asked
for the deferred verification to be closed out). Doing so surfaced two more
real, pre-existing bugs that had never been exercised before because the
`request`-arg crash always short-circuited these tests first:

1. **`load_tsv()` (`api/cache.py`) included every sample's own TSV header
   row as if it were a real gene row** -- plain `csv.reader` with no header
   skip, so `_TSV_CACHE[sample][0]` was
   `MappingRow(gene_id='gene_id', contig_id='scaffold_id', taxonomy='taxonomy',
   kegg_id='kegg', enzyme='enzyme', cog_id='cog')` for all 128 samples. This
   polluted `build_mapping_index()` with 4 bogus entries per source
   (`_MAPPING_INDEX['kegg']['kegg']`, `['cog']['cog']`, etc.), each falsely
   "matching" every sample. Confirmed the SQL analog (`migrate_mappings_to_sql.py`)
   does NOT have this bug -- it uses `csv.DictReader`, which correctly treats
   row 0 as field names. Fixed with `next(reader, None)` before the loop (one
   line). New test `TestLoadTsvHeaderHandling` (synthetic TSV, no real data
   needed) confirmed to fail against the pre-fix code, then pass.
2. **`test_mapping_index_values_are_sample_row_tuples` was itself stale**,
   asserting `isinstance(row, dict)` when `MappingRow` is a deliberate
   NamedTuple (see its own docstring re: memory overhead) -- would have kept
   passing or failing for the wrong reason regardless of the header bug.
   Fixed the assertion to check `isinstance(row, MappingRow)`.
3. **`test_mapping_rows_sorted_chronologically` compared results with plain
   `datetimes == sorted(datetimes)`** -- lexicographic string sort, wrong for
   the unpadded `"M/D/YY H:MM"` format (e.g. `"13:00"` sorts after `"1:00"`
   as strings). This exact footgun is already documented in
   `is_within_date_range()`'s docstring. The route's real sort
   (`timepoint_dt_sort_key`) was already correct; only the test's comparison
   was wrong. Fixed to compare `timepoint_dt_sort_key` values instead,
   matching the convention `tests/sql/test_mappings_search_route.py`'s
   `test_results_sorted_chronologically` already uses.

Also fixed `api/index.py`'s stale `build_mapping_index()` docstring ("row_dict"
-> MappingRow). Final verification: all 11 tests across `TestMappingSearch`,
`TestSmokePatched`, and `TestLoadTsvHeaderHandling` pass against real data
(853s, dominated by the real warmup).

### ~~W13. Dead normalization helpers with a misleading comment~~ Fixed

`frontend/src/utils/signal.ts` exports two functions claimed to be used by
MultiEgcChart that nothing outside tests calls.

**Fixed.** Confirmed `applyL1Normalize` and `buildTimepointTotals` were
imported only by `utils.pure.test.ts` -- every chart component (`EgcChart.tsx`,
`MultiEgcChart.tsx`, `GroupedEgcChart.tsx`) only imports `applyZScore`/
`applyLowess` from `signal.ts`. `MultiEgcChart`'s actual "Relative Abundance"
mode reads a precomputed `norm_egc` field from the API response
(`extractNormEgc`), not a live computation -- a different metric (per-sample
depth normalization) than what these functions implement (egc / sum of the
*displayed* series at that timepoint, a cross-series proportion). Presented
the choice to the user directly: remove the dead code, or wire it up as a new
UI toggle. **User chose removal** -- no feature currently calls for the
cross-series-proportion metric, and it would be new scope beyond a bug fix.
Removed both functions, their doc comments, and their now-unused imports
(`extractEgc`, `AnnotationItem`) from `signal.ts`; removed the corresponding
~19 tests (`applyL1Normalize` describe blocks + `buildTimepointTotals`
describe block, plus its local `makeItem` helper) from `utils.pure.test.ts`.
`npx tsc --noEmit -p tsconfig.app.json` clean; `utils.pure.test.ts` +
`chart-controls.unit.test.ts` (the files that actually import `signal.ts`)
pass 236/236 (was 251 before removal, consistent with the 15 deleted tests).

---

# Part 4 — Test blind spots

### ~~T1. The tests do not pin the behaviour that is actually broken~~ Fixed

- ~~`norm_egc` is never checked against an absolute value for COG, Enzyme or
  Taxonomy. The assertions (constant ratio within a sample, same across sources,
  in (0, 1]) hold for any denominator.~~ **Fixed.** Added
  `tests/test_weighted_totals.py::TestNormEgcMatchesSqlDatabase` -- for one
  real, independently-verified annotation per source (COG0055, K02112,
  EC:7.1.2.2, and Archaea for taxonomy) across the first 5 real samples,
  recomputes the true shared denominator via `calculate_denominator_egc` and
  checks it against the SQL database's persisted `norm_egc` column exactly
  (1e-9 tolerance). Confirmed this is not a tautology by deliberately
  corrupting the denominator (x2) and verifying the assertion then fails for
  every sample. All 4 pass against real data (~65s, since
  `calculate_denominator_egc` reads real mapping TSVs + depth files).
- ~~The BRITE hierarchy test re-implements the buggy parser and compares the
  notebook's output to that clone, so E14 cannot be caught.~~ **Already
  fixed as a side effect of the E14 fix itself**, before this Part 4 pass
  started: `tests/test_annotation_trees.py::TestKEGGHierarchyRollup::
  test_hexokinase_scaffold_reaches_glycolysis` checks real gene/scaffold
  ground truth (not a re-derivation of the parser being tested) and does
  catch E14 -- confirmed by construction during that fix. What this pass
  added: clarified `TestKEGGBriteHierarchy`'s docstrings (the class, its two
  `brite_dict`-comparison tests, and the `brite_dict` fixture itself) to
  explicitly state that class checks a different, narrower property
  (single "last occurrence wins" DISPLAY metadata, matching `.ko.json`'s own
  intentional convention) and cannot substitute for
  `TestKEGGHierarchyRollup`'s real multi-parent regression coverage --
  removes the risk of a future reader mistaking "BRITE/JSON match" for "E14
  is covered here."
- ~~`test_all_jgi_cogs_spot_sample_pass_rate` allows 20% of COG values to be
  wrong while conftest states COG matches JGI exactly.~~ **Fixed.**
  Verified real current pass rate first (didn't just tighten blindly): 0
  mismatches out of 4,475-4,545 COG entries on 5 different real samples
  (100% each) using the SAME near-exact `egc_within_tolerance` the rest of
  the suite already uses -- the 20%-divergence paralog scenario the old
  docstring described no longer occurs in the regenerated dataset. Gate
  changed from `pass_rate >= 0.80` to `failed == 0`; docstring rewritten to
  explain the history and why zero tolerance is now correct.
- ~~No correlation test covers lag direction, NaN input, or the real KEGG
  parent format. All 49 pass against code with CR1, CR3 and CR4
  present.~~ **Already fixed as a side effect of the CR1/CR3/CR4 fixes**
  during Part 2, before this Part 4 pass started -- confirmed by re-running
  them directly: `test_correlation_tier1_cache.py::
  TestLagSignDependsOnCallersReference` covers a known-lag pair in both id
  orders (CR1); `test_correlation_math.py::TestCoreScoring::
  test_returns_none_for_a_constant_candidate` covers the NaN/constant case
  (CR4); `test_correlation_family.py::TestExclusionRules::
  test_kegg_multi_parent_ko_excluded_from_every_real_parents_family` covers
  the real multi-parent KEGG format via `kegg_paths` (CR3). No new tests
  needed here.

**Fix:** assert `norm_egc == egc / calculate_denominator_egc(...)` across all
four sources; assert K00844 is reachable from 00010; require zero COG failures;
add correlation tests for a known-lag pair in both id orders and for a constant
candidate.

---

# Re-audit checklist

## EGC calculations

- [x] **E14** Glycolysis EGC ≥ any member KO in every sample; KEGG JSON and SQL regenerated
- [x] **E15** COG category nodes exist with `depth` and `parent_id`
- [x] **E16** Internal lineage repeats counted; collapse removed or limited to trailing repeats -- counted first: 7.6M of 71.1M lineage observations (10.7%) across all 128 real `.a.phylodist.txt` files have a non-trailing repeat, far more common than the audit's own "may be rare or absent" spot-check suggested. Collapse removed entirely (not limited to trailing) -- traced through the code and confirmed the collapse was never actually needed to prevent double-counting (node_key is already a full lineage prefix, so two same-named consecutive ranks already produce distinct keys). Also confirmed `taxon_paths` (the Mappings table) never collapsed in the first place, so this fix brings EGC_TAX_TREE.ipynb's parsing in line with a convention the rest of the app already used. Regenerated all 128 `.tax.json` files, resynced SQL, rebuilt `annotation_catalog`. New tests in `tests/test_annotation_trees.py::TestTaxonomyLineageCollapseRemoved` (one is a ground-truth check against the raw phylodist file, confirmed to actually fail against the pre-fix data, not just pass trivially either way). Full regression suite (376 tests, sql + correlation + annotation_trees) green with zero failures.
- [x] **E5** Single shared scaffold-ID helper; no gene IDs with a field count other than 4. ❌ **Shared-helper refactor rejected** -- already decided in the prior audit round, reconfirmed here: checked all 128 samples across both `.a.cog.txt` and `.a.ko.txt`, every real gene id is exactly 4-field, so `All_Coverages.py`'s and "everywhere else"'s derivations always agree in practice; doesn't matter given our real database. Note for later: the raw JGI data itself is inconsistently labeled here -- `.a.depth.txt`'s `AvgFold` column is keyed by scaffold id (2 fields, e.g. `Ga0590986_0000001`), not gene id (4 fields), which is what actually made this easy to misdiagnose (the audit's own suggested verify command checks the wrong file for this reason).
- [x] **E6** KEGG intermediate regenerated, or the notebook fails on a stale one -- found a deeper gap while investigating: `KEGG_preDatabase.ipynb`'s saved state had no step that actually wrote `kegg_db.json` at all (confirmed no `json.dump`/`kegg_db.json` anywhere in it), and several of its other cells reference undefined variables and would crash if run. New, focused `Build_KEGG_DB.ipynb` extracts just the working read-and-build logic (with E7/E8 already applied) plus the missing write step. `EGC_KEGG_TREE.ipynb` now raises before loading `kegg_db.json` if any real `.a.ko.txt` is newer than it, pointing at the new notebook. Confirmed live: the check passes cleanly against current data (not stale), so no regeneration was forced by this fix.
- [x] **E7** Exactly one `.a.ko.txt` per sample; `rglob` replaced with a direct path -- confirmed live (all 128 samples, exactly one match each) before fixing, so this changes no current output, only removes the future-duplicate risk
- [x] **E8** KEGG reader no longer swallows exceptions -- `try/except Exception: print(...)` removed from `read_ko`; a real read failure now crashes loudly instead of continuing on partial data
- [x] **E9** Reference-gating documented; drop counts logged -- all three trees (COG/KEGG/Enzyme) now track and print dropped-id counts + examples. Real counts computed directly against current data and documented in full in `docs/MISSING_ANNOTATIONS.md`: COG 19/4,631 (0.4%), KEGG 33/12,286 (0.3%), Enzyme 155/3,395 (4.6%, but 135 of those are partial/wildcard EC calls like `1.1.1.-` that were never going to match a fully-resolved reference -- only 20 are the same kind of gap as COG/KEGG's)
- [x] **E10** `;` confirmed absent; split replaced by an assertion -- both KEGG and Enzyme now assert exactly one id per lookupId entry instead of silently taking `.split(';')[0]`; confirmed the assertion doesn't currently fire against real data
- [x] **E12–E13** Contradictory comments and UI copy corrected -- E12: `tests/conftest.py` already had an accurate, detailed methodology note (not the vague "exact agreement" claim the audit describes), nothing to fix. E13: removed the redundant "per liter" paragraph from `AboutPage.tsx` (fully superseded by the correct "Metric:" paragraph right above it, which was already right). While in there, per user request, also brought the rest of the page up to date: the "Spearman CLR Correlation" description was describing a CLR-transform system that no longer exists (the live implementation never used CLR) -- rewritten to describe the real 4-method (raw_pearson/log_pearson/spearman/circular_shift) + Bonferroni + BH pipeline. The API Reference table was pointing at `/api/annotations/correlate`, the deprecated JSON-backend route (see W1) the app no longer actually uses -- replaced with the real `/correlation` and `/correlations/family` routes, and added 4 routes that existed but weren't documented at all: `/kegg/children`, `/enzyme/children`, `/cog/children`, `/taxonomy/export`.
- [x] `weighted_totals.py` and `All_Coverages.py` no longer hardcode a Windows path -- both now derive their paths from `Path(__file__)` (same pattern `weighted_totals.py`'s own `get_sample_names()`/`get_gene_counts()` already used), instead of one developer's absolute path. Verified live from two different working directories: loads all 128 samples correctly, and the computed denominator for 3300060358 (16,137,978.0) is byte-identical to the value already printed throughout every EGC notebook this session -- confirms this is a pure portability fix, zero behavior change.

## Correlation feature

- [x] **CR1** Lag sign correct for a reference with the higher catalog id; test in both orders
- [x] **CR2** Autocorrelation-aware null; simulated independent AR(1) pairs pass q < 0.05 at ≤ 5% -- circular-shift permutation restored (re-searches all 9 lags per shift, not fixed-lag), verified with the exact simulation this item describes: 150 independent AR(1) pairs, φ=0.85, n=128 (same parameters as the audit's own ~51%-under-the-old-gate measurement) -- measured 1.3% pass rate under q<0.05 (`tests/test_correlation_math.py::TestCR2FalsePositiveRateSimulation`). ⚠️ Available as an additional `method=circular_shift` choice, not the default -- the 3 original methods (raw_pearson/log_pearson/spearman) still use the uncalibrated parametric p-value; a user has to actively pick circular_shift to get this guarantee.
- [x] **CR3** Within-kegg family for 00010 excludes 09101 and its member KOs; `parent_id` stored -- `parent_id` stored (was `parent_name`). Descendant/ancestor/sibling exclusion for kegg rewritten to read `kegg_paths` (`_kegg_family_exclusions`) instead of the single-valued `parent` column, since a KEGG node can have multiple real parents (K00844 has 14, per E14) that one column can't represent. Verified live against the audit's own exact example: 00010's family now correctly excludes both 09101 (ancestor) and K00844 (the multi-parent descendant that was previously missed). Enzyme/COG/taxonomy untouched -- confirmed single-parent by construction, no bug there. Negligible perf impact (32ms for K00844 itself as ref, the worst-case 14-parent node).
- [x] **CR4** Constant candidate returns 200 and is omitted
- [x] **CR5** Results sorted by strength and capped
- [x] **CR6** `load_sample_order` fails on an undatable sample; spacing asserted -- undatable-sample failure implemented (`assert_sample_order_is_trustworthy`, called at SQL-backend startup, also catches two samples colliding on the same timestamp). ❌ **"spacing asserted" rejected as literally stated** -- checked live first (this project's own habit, not skipped lightly): real data has legitimate 8h/12h gaps from missing samples, so a strict "must be exactly 4h apart" assertion would crash the server on valid, real data. `lag_hours` stays an approximation across a gap; no assertion added for it.
- [x] **CR7** Dead batch job removed; loaders moved

## Web application

- [x] **W1** JSON `/correlation` route removed -- `correlation.router` no longer imported or included in `main.py` (both the unprefixed and `/api`-prefixed mounts removed); confirmed live via `main.app.routes` inspection that no route path contains "correlate" while `/correlations/family` (the SQL replacement) is still present. `correlation.py`'s internal functions (`correlate_annotations`, `get_clr_matrix`) are still exercised directly by `TestCorrelationLock`/`TestCorrelationValidation`/`TestGetClrMatrix` (11 tests) since those call the Python functions, not the HTTP route -- all still pass, confirming the removal didn't break anything that legitimately depends on the module.
- [x] **W2** Both date bounds filter correctly on Top EGC Annotations; `sample_count` reflects the filter -- new `is_within_date_range()` helper (real datetime comparison, not text), applied to both backends; `sample_count` now reflects the actual filtered count, not the full dataset. Verified live against the real server (57/128, 21/128, and an independently cross-checked exact 9/128 for a narrow window) plus 20 unit tests (`tests/test_unit_backend.py::TestIsWithinDateRange`, `TestParseDatetime`) and 3 new live-route regression tests (`tests/sql/test_top_annotations_route.py`).
- [x] **W14** Overview "Summed EGC" trace equals the sum of member series at every timepoint -- new `sumMembersByTimestamp()` helper sums per timestamp before charting; verified against the audit's own real numbers (823,158 -> 4,854,154) plus 5 more unit tests. Also caught and fixed an unrelated regression: an About-page heading collided with the "Find Correlates" button text, silently breaking 11 unrelated tests.
- [x] **W15** Scaffold Information date filter removes only out-of-range points -- all 3 spots now use `isoDate()` before comparing; extracted/exported `filterSummaryForChart`/`buildAggregatedChartRows` so tests import the real logic instead of a stale local duplicate that used fixtures which never exercised the bug. 6 new regression tests with the real raw date format, confirmed to fail pre-fix.
- [x] **W16** Scaffold chart points sit at the same local time as the table row -- replaced `new Date(...).toISOString()` with `toPlotlyDate(...)` in all 3 files; confirmed the shift was real on this machine's own (Pacific) timezone, 6 new tests.
- [x] **W17** Mappings panel default order is chronological; CSV matches -- `sortMappingRows` now compares `parseDateTime(...)` numerically instead of raw-string `localeCompare`; CSV needed no separate fix (reuses the same sorted list). 4 new tests with the real raw date format, confirmed to fail pre-fix with the exact wrong order the audit found.
- [x] **W18** Every CSV export names its value column by the active metric and records transforms -- fixed all 4 sites (3 charts, 1 removed-redundant-button); extracted each chart's CSV row logic into a testable pure function. 20 new tests.
- [x] **W19** Nested exclusions subtract once; failed exclusion fetch shows an error -- verified the hierarchical-rollup premise live; `computeExclusionSeries` skips covered descendants when summing, `TaxonomyTree` disables their checkboxes; `TaxonomyPage` now distinguishes failed from loading and shows an explicit error banner. 19 new tests, confirmed to fail pre-fix.
- [x] **W20** Per-sample routes work under SQL or are removed from the API page -- removed all 8 (7 audit-listed + 1 same-defect sibling found incidentally), confirmed unused by the frontend and confirmed the 404 is a real production data-availability gap (55GB+ JSON never deployed), not a code bug worth a parallel SQL implementation. Orphaned helpers, docs, and JSON-only tests removed alongside. No regressions (317 passed, same 12 known pre-existing failures before/after).
- [x] **W3** Search no longer matches on short indexed substrings -- removed the `key in token` matching direction entirely (a length guard alone can't reach zero false positives: real words like "red"/"err" are genuinely embedded in "ferredoxin"). Verified against the full real 128-sample index: 113 false positives -> 0, 29 genuine matches found. 3 new tests in `TestSearchIndex`, confirmed to fail pre-fix.
- ❌ **W4** Mapping search identical across backends -- investigated live (K1 -> 282,671 rows via JSON backend's substring fallback, confirmed root cause: kegg/enzyme prefix mismatch between raw TSV and catalog ids means exact match never succeeds for those sources today, not just edge cases). Real fix requires re-deriving most of `get_mappings_sql`'s per-source logic (prefix normalization, enzyme multi-value split, taxonomy prefix semantics) for the JSON backend. Per user: JSON backend is being retired, not worth the investment -- left as-is.
- [x] **W5** Lookup card identical across backends -- `get_search_annotations` now returns `category`/`scaffold_count` top-level (correlated subqueries against `annotation_series`; `category` is exact, `scaffold_count` is a real but arbitrary-sample count, not necessarily "earliest" -- an ordered version was minutes-slow with no supporting index, rejected). Frontend reads whichever shape (SQL top-level or JSON nested `value.*`) is present via 3 new resolver functions. Verified live end-to-end plus 5 new SQL tests + 12 new frontend tests.
- [x] **W7** Eukaryota rows show generic level labels -- `taxonomyRankLabel` now takes an optional domain (derived from the annotation id's own lineage prefix, no new data needed) and falls back to "Level N" only for Eukaryota. Fixed 7 per-annotation call sites; left 4 depth-only filter-pill sites unchanged (ambiguous, can span multiple domains). Also fixed the identical bug in `expandParentLabel`'s taxonomy branch, and a component test that had pinned the bug as intended behavior.
- ❌ **W8** Taxonomy CSV export works on both backends -- confirmed both routes only ever had a SQL implementation (`/taxonomy/export`) or are a SQL-connectivity debug check by design (`/sql-test`, also relied on by the test suite to detect which backend is live). Both work correctly under `DATA_BACKEND=sql`, the persisting backend. Per user: JSON backend is being retired, not worth building a parallel implementation -- left as-is.
- [x] **W9** Grouped CSV export chronological -- unified both duplicate copies to call the shared, now-sorted `sumMembersByTimestamp`. 2 new tests, confirmed to fail with a plain string compare.
- ❌ **W10** Search results stable across index readiness -- confirmed a real (narrower than described) case-sensitivity gap in the JSON backend's `annotation_id` exact-match param between its warmup-scan and ready-index paths; "single-sample" in the original description doesn't match the actual scan code. Entirely confined to `DATA_BACKEND=json`'s internal paths -- SQL has no such distinction. Per user: JSON backend is being retired -- left as-is.
- [x] **W11** unique-pairs count identical across backends -- `_sort_group_concat()` makes the dedup key's inputs deterministic. Note: this real database's natural GROUP_CONCAT order already happens to come back sorted, so the fix addresses the missing guarantee rather than a currently-reproducible flip-flop; 5 direct unit tests on the sort function itself are what actually pin it down. 7 new tests.
- [x] **W12** CI backend job green -- 6 `search_mappings()` call sites across `TestSmokePatched`/`TestMappingSearch` were missing the `request` arg the SQL migration added; added a `sql_request` fixture (real sqlite connection) and threaded it through all 6. The 2 CI-flagged tests verified passing; the other 4 (skip-guarded locally by an always-empty-under-sql `_MAPPING_INDEX`) share the identical fix but weren't re-run against real data (would require a multi-minute full JSON-dataset warmup).
- [x] **W13** Dead normalization helpers removed or wired up -- user chose removal; `applyL1Normalize`/`buildTimepointTotals` and their tests deleted from `signal.ts`/`utils.pure.test.ts`.

## Tests

- [x] **T1** Absolute `norm_egc` assertion, BRITE reachability test, zero-failure COG gate, lag-direction and NaN correlation tests -- ALL DONE. New `TestNormEgcMatchesSqlDatabase` (absolute norm_egc check); BRITE reachability was already covered by `TestKEGGHierarchyRollup` (added during the E14 fix), `TestKEGGBriteHierarchy` docstrings clarified to prevent confusion with it; COG gate tightened to `failed == 0` after confirming 100% real pass rate on 5 samples; lag-direction (CR1), NaN/constant-candidate (CR4), and real-KEGG-parent-format (CR3) correlation tests were already in place as a side effect of Part 2's work.
