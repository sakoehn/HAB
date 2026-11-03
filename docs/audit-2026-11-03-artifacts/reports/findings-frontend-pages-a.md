# Metatrace frontend audit — Analyze / Compare / Taxonomy pages, hierarchy utils, Correlates panel

Branch `feature/sqlite-integration`, HEAD `a993ead`. Read-only review; probes live in
`/tmp/claude-1000/-home-mriffle-dev-sophie-metatrace-HAB/9598effd-5bf0-4fbf-a9d0-bea8f89cfec9/scratchpad/`
(`tests/audit-compare.test.tsx`, `tests/audit-app-handoff.test.tsx`, `check_rollup.py`, `handoff-test-output.txt`).
The probe tests were run by copying them into a temporary untracked folder under `frontend/src/tests/`
(Vitest refuses files outside its root) and deleting it afterwards; `git status` is clean.
Existing in-scope suites (19 files, 404 tests) pass; `tsc --noEmit -p tsconfig.app.json` is clean.

---

### [H] "View Timeseries in Analyze" cannot find any taxonomy row below domain level

**Where:** `frontend/src/App.tsx:171-183` (`handleSendToAnalyze`) → `frontend/src/pages/AnalyzePage.tsx:810-838` (`runSearch`); origin `frontend/src/pages/ExplorePage.tsx:2331`.

**What is wrong:** The handoff puts the row's `annotation_id` into the Analyze search box and auto-runs it as a free-text `q`. For taxonomy the id is the full lineage (`Archaea;Euryarchaeota`), and `/search/annotations` matches taxonomy rows on `name` only (`FastAPI/api/cache_sql.py:899-909`), so the query matches nothing.

**User-visible effect:** Explore → Annotation Lookup → source *taxonomy* → search "Euryarchaeota" → "View Timeseries in Analyze" lands on Analyze showing `No annotations found for "Archaea;Euryarchaeota"`. Works only for the four domain names and for kegg/cog/enzyme ids.

**How verified:** Live: `GET /api/search/annotations?q=Archaea%3BEuryarchaeota&sources=…` → `total: 0`, while `q=Euryarchaeota` → 9 rows. Wrote an App-level test with a fetch mock that emulates name-only matching; it logged the Analyze request `…?q=Archaea%3BEuryarchaeota&sources=kegg&…&page_size=5000` and rendered the "No annotations found" box (`handoff-test-output.txt`).

**Suggested fix:** Hand over the taxon's bare name (`bareTaxonName(id)`) as the query, or add an exact-id path (`annotation_id=` + `sources=<source>`) to `handleSendToAnalyze`/`runSearch` so the handed-over row is found regardless of source.

---

### [H] Searching the documented `EC:`/`KO:` id forms returns the wrong source's results

**Where:** `AnalyzePage.tsx:820-826`, `ComparePage.tsx:388-393`, `TaxonomyPage.tsx:83-85` (all pass the typed text verbatim as `q`); documented id forms in `MethodsPage.tsx:69-73` ("EC:1.1.1.1 · EC:4.2.1.17"). Backend `search_annotations` strips the prefix only for the `annotation_id=` parameter (`routes.py:531`, `cache_sql.py:1124`), not for `q`.

**What is wrong:** Catalog enzyme ids are bare (`1.1.1.1`, parent `1.1.1`; confirmed live). `q=EC:1.1.1.1` therefore cannot match the enzyme, but it substring-matches every KEGG KO whose *name* contains `[EC:1.1.1.1…]`.

**User-visible effect:** Typing `EC:1.1.1.1` (the form the Methods page gives) in Analyze or Compare returns 41 KEGG KOs — alcohol dehydrogenase is not among them, but `fabG [EC:1.1.1.100]`, `paaH [EC:1.1.1.157]` etc. are — and zero enzyme rows. `KO:K00001` returns nothing at all. Bare `1.1.1.1` returns 92 rows (50 kegg, 42 enzyme) with the exact match 5th.

**How verified:** Live GETs (counts above). Code read for where `q` is built.

**Suggested fix:** Strip a leading `EC:`/`KO:` from the typed query on the client (or in the backend `q` branch when the remainder looks like an id), and consider ranking an exact `annotation_id` match first.

---

### [M] Compare: "Select top N" + "Add N selected" opens an already-open annotation a second time

**Where:** `ComparePage.tsx:456-462` (select-all builds the key list from `searchResults.slice(0, slotsRemaining)` without excluding already-added rows); `ComparePage.tsx:415-451` (`addSelectedAnnotations` has no duplicate check, unlike `addAnnotation` at :469-472).

**What is wrong:** The per-row checkbox is disabled for an added row, but the header "Select top N" bypasses that and the bulk add trusts the set.

**User-visible effect:** With K00001 open, search "K000", click "Select top 3", click "+ Add 2 selected": K00001 now has two chips and is drawn twice on the overlay (two colours, both counted in the CSV export), occupying a slot of the 4.

**How verified:** Wrote test `Compare: "Select top N" then "Add N selected" with an already-open row` — fails under current code (`expected 2 to be 1` K00001 chips).

**Suggested fix:** Exclude rows already in `state.entries` from the select-all key list and from `toAdd`.

---

### [M] Compare: a series handed over from Analyze can get the same colour as a series already on the page

**Where:** `ComparePage.tsx:148` (`resetSourceCounters()` on every handoff) with `ComparePage.tsx:163-166` (`nextColorForSource`); counters are module-level in `constants.ts:60-72` and shared with Analyze cards.

**What is wrong:** The reset rewinds the per-source shade counter to 0 even when entries already on the Compare page were coloured from it, so the newcomer repeats shade 0.

**User-visible effect:** Add K00001 on Compare (sky-blue shade 0). Go to Analyze, send K02014 → it is also sky-blue shade 0; the two kegg lines and their legend swatches are indistinguishable.

**How verified:** Wrote test `Compare: colours after an Analyze handoff` — fails (`'rgb(86, 180, 233)'` for both chips).

**Suggested fix:** Do not reset the counters on handoff (only when the page becomes empty, as the chip-remove handler already does), or pick colours not used by current entries.

---

### [M] Compare: a handed-over group with the same label as an open group is dropped silently

**Where:** `ComparePage.tsx:134-140`. Handoff keys are `group:${label}`; the label is `${searchTerm} (${n})` (`AnalyzePage.tsx:954`), so two different groups from two "iron" searches with two members each both read `iron (2)`.

**What is wrong:** `incoming` filters out anything whose key is already open; filtered-out items are not added to `handoffSkipped`, so the second group vanishes with no notice. (Analyze's own drawer avoids this by keying groups on a UUID, `AnalyzePage.tsx:957`.)

**User-visible effect:** Compare shows one "iron (2)" chip; the user who just clicked "→ Compare page" sees nothing happen and no message.

**How verified:** Wrote test `Compare: a handed-over group with the same label as an open group` — fails (1 chip, no notice).

**Suggested fix:** Key groups by their member set (sorted `source:id` list) rather than label, and report anything skipped as "already open".

---

### [M] Same-named taxa at different depths get an identical "hint" and are not told apart

**Where:** `frontend/src/utils/taxonomy.ts:247-273` (`homonymHints`); used by `LeftResultList.tsx:151,333-341`, `ComparePage.tsx:508-510,768,…`, and MultiEgcChart's legend.

**What is wrong:** The loop starts at `min(len)-2` and walks up while segments agree; when one lineage's ancestor chain is a prefix of the other's (same name at different ranks), it bottoms out at index 0 for both, so both get the domain as their hint.

**User-visible effect:** This shape is real: a search for "Euryarchaeota" returns `unclassified Euryarchaeota` at depths 3, 4, 5 and 6 (`Archaea;Euryarchaeota;unclassified Euryarchaeota`, `…;unclassified Euryarchaeota;unclassified Euryarchaeota`, …). In Analyze all four rows read "unclassified Euryarchaeota in Archaea" (the rank column still differs); on Compare the chips and chart legend read "unclassified Euryarchaeota · Archaea" for every one, so two such series on the overlay cannot be distinguished.

**How verified:** Live search (ids above); unit probe `homonymHints: same name at different depths` fails (`'Bacteria'` for both).

**Suggested fix:** When the computed hints collide, append the rank (`taxonomyRankLabel(depth)`) to the label, or include the depth difference in the hint.

---

### [L] Compare: the "not added" handoff notice survives "Clear Page"

**Where:** `ComparePage.tsx:130` (`handoffSkipped` is component-local), `App.tsx:118-120` resets only `CompareState`.

**User-visible effect:** After "Compare holds 4 annotations, so K02014 was not added…" appears, clicking Clear Page empties the chips but the notice (naming an annotation that is no longer anywhere) stays until dismissed.

**How verified:** Wrote test `Compare: "Clear Page" clears the handoff notice` — fails.

**Suggested fix:** Clear `handoffSkipped` (and `bulkSelected`, `searchTotal`) when `state.entries` becomes empty or on reset; or move it into `CompareState`.

---

### [L] Taxonomy: "remove" line can carry a tiny negative relative abundance

**Where:** `utils/taxonomy.ts:98-104,112` (`computeExclusionSeries` subtracts `norm_egc` without clamping).

**User-visible effect:** Scope Archaea, check all 9 phyla → EGC line is exactly 0 everywhere, but the relative-abundance line is −1.39e−17 … +2.78e−17; the hover (via `formatRelativeAbundancePercent`) prints values like "-1.39e-15%". Cosmetic, but it reads as if the remaining share were negative.

**How verified:** `check_rollup.py` against the live API: EGC residual root − Σ children is exactly 0 in all 128 samples (so the roll-up is exact and the exclusion arithmetic is right); norm residual min −1.388e−17, max 2.776e−17.

**Suggested fix:** `Math.max(0, …)` on both egc and norm in `computeExclusionSeries` (and document that the scope can never go below 0).

---

### [L] Three COG category names differ from what the backend serves

**Where:** `constants.ts:107,120,124` (`COG_CATEGORY_LABELS` D, Q, U) vs live `/api/cog/children`:
- D: "Cell cycle control, division, chromosome partitioning" vs "Cell cycle control, cell division, chromosome partitioning"
- Q: "…biosynthesis, transport, catabolism" vs "…biosynthesis, transport and catabolism"
- U: "Intracellular trafficking, secretion, vesicular transport" vs "…secretion, and vesicular transport"

**User-visible effect:** The same category is spelled two ways depending on code path (search-result `category`/name from the server vs. `primaryLabelWithCogCategory`/`expandParentLabel` from the table): e.g. a COG card's Parent row reads one wording, the Compare chip for category U another.

**How verified:** Live GET compared to the table. (Y "Nuclear structure" is in the table but not served; harmless.) KEGG_BRITE_CODES (449 unique keys) and ENZYME_CLASS_LABELS matched everything checked (all 48 parent codes in the top-200 kegg list, all 7 EC classes).

**Suggested fix:** Regenerate the three strings from `cog_paths`, or drop the table in favour of the served names.

---

### [L] Correlates panel: rows with n < 30 are dimmed and called "not statistically reliable" even when significant

**Where:** `CorrelatesPanel.tsx:355-357,361,366,421-432`.

**What is wrong:** Since the effective-N method landed, the shared-timepoint count is already inside the test (Methods: "an r of 0.90 from 10 shared timepoints was not significant"). A row can carry a "significant" q badge and, next to it, "⚠ n=28 — treat this correlation as exploratory, not statistically reliable", with the whole row greyed. Also `METRIC_LABEL.norm_egc` is "norm EGC" while every other panel calls it "Relative Abundance".

**How verified:** Code read.

**Suggested fix:** Reword to "only N shared timepoints" without the reliability verdict, and stop dimming significant rows; rename the metric label.

---

### [L] About page lists five Explore views; there are six

**Where:** `AboutPage.tsx:62-66` ("Five views — Dataset Overview, Top EGC Annotations, Annotations by Parent, Annotation Lookup, and Scaffold Information"); README and `types.ts:339` include Bulk Download.

**How verified:** Code read.

---

### [L] Analyze "∑ Group" sums annotations that overlap without saying so

**Where:** `AnalyzePage.tsx:878-918`, `LeftResultList.tsx:231,241` ("Sum EGC across N selected annotations").

**What is wrong:** Only same-source containment (ancestor/descendant) is removed. Two sibling pathways that share KOs, or a KO + its COG + its EC (the same genes three times), are summed without a caveat; the card says "N annotations" and the drawer "N annotations summed". The Methods page notes the multi-parent effect for hierarchy roll-ups, not for user-built groups.

**How verified:** Code read.

**Suggested fix:** A one-line note on the group card ("annotations that share genes are counted once per annotation"), or warn when members span sources.

---

### [L] Hard-coded 128 in the result list

**Where:** `LeftResultList.tsx:36,349,354-357` (`TOTAL_SAMPLE_COUNT = 128` in "(N/128)").

`useAllSamples` already supplies the real count to the same page; use it so the denominator cannot drift. No user-visible error today.

---

## Checked and found correct

- **Taxonomy exclusion / inclusion arithmetic** (`utils/taxonomy.ts`, `TaxonomyPage.tsx:194-257`): scope and each checked branch fetched from `/series/annotations` (page_size 500 ≥ 128); joined per sample by sample name, not index; branch absent in a sample contributes 0; sample absent from the scope is dropped (so the "full" and derived lines have the same gaps); nested checks are filtered both in the UI (`isCoveredByAnotherExclusion`, checkbox disabled, drill-down blocked) and again in the sum, so no double subtraction even if a child was checked before its parent; Remove ↔ Keep switches keep the same set and the two lines are exact complements of the scope; both `egc` and `norm_egc` are computed so the metric toggle needs no refetch. Live check on Archaea: domain EGC equals the sum of its 9 phyla (incl. "unclassified Archaea") exactly in every sample, so the scope minus all children is 0, never negative beyond float noise. Legend names ("X (full)", "X (minus N exclusions)", "A + B") and title ("X — Excluding/Only …") describe what is drawn; the title lists a redundant nested child while the legend count does not, which is consistent, only verbose.
- **Correlates lag wording matches the backend.** `_spearman_at_lags` pairs `ref[t+lag]` with `cand[t]` for lag > 0, so a positive lag means the candidate leads; the cache stores the pair with the lower catalog id as `ref` and negates on read when the reference is the higher id, so `lag_samples` returned to the panel is always in reference-vs-candidate orientation. Panel: positive → "leads by Xh", tooltip "the other annotation tends to peak earlier" — correct.
- **Correlates panel state:** every attempt clears rows/counts (`setData([])`), a request sequence number discards late responses, retries only on abort/5xx, changing source/method/metric refetches and clears; counts shown as "S of T significant (q<0.05, BH-corrected)" and "showing top N of T tested"; q is labelled as BH FDR (p is not displayed at all); "+" adds `row.annotation_id` with the target source (catalog ids are bare, and `/series/annotations` strips prefixes anyway). The panel is per card, so results can never belong to another annotation.
- **Analyze:** series cache keyed `${id}::${source}`, so a slow response can only overwrite its own key; metric switch is chart-internal and reuses the same rows (both egc and norm_egc are fetched once); search uses `page_size=5000` matching the backend cap, shows "N results · showing top M · refine to narrow" when truncated; superseded searches are ignored; tabs keyed by position; group sum (`sumMembersByTimestamp`) keyed by datetime with absent members contributing 0; nested members dropped with an alert naming the container (taxonomy by `;`-prefix, kegg/cog/enzyme via every path from `/{source}/path`); card header mean shows "n / total samples" so the detected-only mean is explicit; result list tooltip says "Mean when detected".
- **Compare:** rows keyed by datetime (not index), missing samples get explicit `null` and traces use `connectgaps: false` → gaps, not zeros; Z-score is per series over that series' non-null points in the active date window; entries keyed by UUID; cap of 4 enforced in both add paths; `/samples?page_size=200` returns all 128.
- **Hierarchy utilities:** taxonomy containment is `startsWith(other + ';')` (so "Bacteria;Proteo" does not cover "Bacteria;Proteobacteria…"; pinned by existing tests); KEGG multi-parent and COG multi-category handled through all paths from `/kegg/path` and `/cog/path`; enzyme ids are bare in the catalog so `/enzyme/path` needs no prefix handling; `depthLabel` per-source names (kegg 1–4, cog 1–2, enzyme 1–4) match the backend's depth semantics and `TAXONOMY_RANK_NAMES` 1–8 matches `RANK_COLUMNS`; `AnnotationInfoDrawer` lists every real immediate parent.
- **constants.ts:** `KEGG_BRITE_CODES` has 449 unique keys and every parent code in the live top-200 kegg list resolves; EC class names match live; `expandParentLabel` handles taxonomy/kegg/cog/enzyme parents in the shapes the catalog serves (`'00982'`, `'C'`, `'1.1.1'`, full lineage).
- **Reset and navigation:** topbar Reset replaces all four page states and the colour counters; per-page Clear replaces only its own state; pages stay mounted so state survives navigation by design (About page says so); `handleSendToAnalyze` resets results/checks before auto-running; `resetKey` only needed by Explore. Date ranges are per page (Analyze per card and per drawer, Compare and Taxonomy in page state) and each is applied to its own chart; none leaks across pages.

## Not verified / outside this scope

- `EgcChart`'s `onVisibleSamplesChange` set (whether the card-header "n / total" total counts undetected samples in the window) and the Z-score window semantics vs. the Methods wording "across the bloom" (μ/σ are taken over the active date window, not the whole series) — chart-component reviewer.
- The prior audit's open items (W21 mean header, N5 stale labels/comments incl. `taxonomyRankLabel`'s unused `_domain`) are still open and not re-described here.
