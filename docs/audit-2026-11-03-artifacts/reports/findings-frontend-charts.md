# Frontend charts audit — Metatrace `feature/sqlite-integration` @ a993ead (2026-11-03)

Scope: everything between the API and the pixels/numbers on EgcChart, MultiEgcChart, GroupedEgcChart (and their helpers in `utils/`, `chartCsv.ts`, `StatsPanel`, `scaffoldChartData.ts`), plus the backend endpoints they read. Read-only; scripts and outputs are in `/tmp/claude-1000/-home-mriffle-dev-sophie-metatrace-HAB/9598effd-5bf0-4fbf-a9d0-bea8f89cfec9/scratchpad/` (`solar_check.py`, `exp.cjs`, `utils.cjs`, `vitest-baseline.log`).

Baseline: `npx vitest run` 59 files / 1,470 tests pass; `tsc --noEmit -p tsconfig.app.json` clean.

Known items from `docs/AUDIT-2026-11-03.md` (W21, W22, N5, T2, T3) are not repeated.

---

## Findings

### [M] Z-score is standardised over the *visible* points, but the Methods page says "mean across the bloom"

**Where:** `frontend/src/components/charts/EgcChart.tsx:204-240` (`filteredPoints` → `unsmoothedPoints` → `applyZScore`), `MultiEgcChart.tsx:107-164` (`baseRows` is already date-filtered before `applyZScore`), `GroupedEgcChart.tsx:72-117`; `frontend/src/pages/MethodsPage.tsx` Z-score item ("A value of +2 means 2 standard deviations above that annotation's mean across the bloom"); `chartCsv.ts:21,45,80` (`standardized: true` flag).

**What is wrong:** μ and σ are computed from the points that survive the chart's date range (and, on Analyze, the Timepoints date/time pills), not from the full 128-sample series. The same sample therefore has a different Z value depending on the window, the axis still reads "σ from mean", and the exported CSV marks rows `standardized=true` without recording the window the standardisation used. The Stats panel has the same property (n/mean/median/s are over visible detected points), which is reasonable, but its title says only "Descriptive Statistics · <metric>".

**User-visible effect:** Analyze card, Z-score on, full range: a 5 June point reads e.g. "+1.2σ". Narrow the range to 1–7 June: the same point now reads e.g. "−0.3σ" (June-week mean/σ), with no label change. Compare page (Z-score is the default there) behaves the same for all series at once. CSV rows exported in the two states carry different `norm_egc` values, both flagged `standardized=true`.

**How verified:** read; data flow is unambiguous (`applyZScore` is called on the filtered arrays in all three charts; `canApplyZScore` is evaluated on the same arrays). Not a numeric error in `applyZScore` itself (verified population σ, see below).

**Suggested fix:** either standardise on the unfiltered series (`allPoints`/full `baseRows`) and then filter, or change the Methods sentence to "mean over the samples currently shown" and record the window in the CSV (e.g. `standardized_over_n`, `date_from`, `date_to`) and in the Stats panel title ("· visible range, detected samples only").

### [L] A failed `/api/samples` (or `/api/tides`, `/api/sun-times`) fetch is never retried for the rest of the session

**Where:** `frontend/src/utils/useAllSamples.ts:46-64`, `useSolarTideData.ts:52-78`. `load()` returns early when `promise` is set; after a rejection the promise stays set and `cache.data` stays null.

**Effect:** one transient failure at page load means every chart opened afterwards draws lines straight across non-detections (with the amber "full sample timeline unavailable" warning) and "N of N samples" headers, until a full reload. Analyze's card-header "n / total" also loses its total.

**How verified:** read. **Fix:** clear `promise` in the `.catch` (or retry on next mount).

### [L] MultiEgcChart does not skip a series row that has no timepoint; the other two charts do

**Where:** `MultiEgcChart.tsx:116-125` (`d.timepoint?.datetime ?? ''` → row with `_ts = parseDateTime('') = 0`). `EgcChart.tsx:142` and `GroupedEgcChart.tsx:86` filter such rows out.

**Effect:** a point would be drawn at 1970-01-01 (local), stretching the x-axis by 51 years. Cannot happen today: `FastAPI/main.py:53` `assert_sample_order_is_trustworthy` refuses to start on an undatable sample. Hygiene-level, but it is the one chart that would mis-draw.

**How verified:** read. **Fix:** `if (!d.timepoint?.datetime) continue` like the others.

### [L] Methods page omits the 4-point LOWESS floor

**Where:** `utils/signal.ts:103` (`LOWESS_MIN_POINTS = 4`, series with ≤3 real points returned unchanged) vs `MethodsPage.tsx` LOWESS item (only "window = max(3, ⌈bandwidth × n⌉)"). The Z-score item does state its own "<2 points" rule.

**Effect:** none on numbers; the UI already drops "(smoothed)" via `canApplyLowess`. Documentation gap only. Verified by running `applyLowess` on 3 points (unchanged) and 4 points (changed).

### [L] Chart control tooltips define relative abundance by the wrong denominator

**Where:** `ChartControls.tsx:103,116` ("norm_egc, EGC ÷ total sample sequencing depth"); same wording in `utils/stats.ts:30` and `AnalyzePage.tsx:447-451` comments. README/Methods define norm_egc as EGC over the gene-weighted depth summed over *annotated* scaffolds ("share of the annotated signal", 27–48% of genes excluded).

**Effect:** label only; the plotted number is the backend's norm_egc. **Fix:** reword to match Methods.

### [L] CSV export hygiene

**Where:** `chartCsv.ts`. (a) The `date` column is the raw PDT wall-clock string (`5/28/21 1:00`) with no zone and no ISO form; (b) `buildGroupedEgcCsvRows` has no `sample` and no `members_detected` column, so a row's value cannot be traced to a sample id or qualified by how many members contributed (the hover shows both); (c) `tide_predicted_wl_m` is the nearest 6-min reading within 30 min, not stated anywhere; (d) nulls are written as empty cells (`api.ts:44`) — acceptable, but undocumented. Values are the displayed (metric/Z/LOWESS) numbers and the `metric`/`standardized`/`smoothed` columns do say so — correct.

**How verified:** ran the builders (`exp.cjs`). **Fix:** add `datetime_iso`/`tz=PDT`, `sample`, `members_detected`; note nearest-reading in a header comment or column name.

### [L] `Trend Δ EGC` quarters are quarters of the *detected* points, not of the time span

**Where:** `ExplorePage.tsx:1016-1028` → `utils/stats.ts:294-304`. For an annotation detected in 8 of 128 samples the "first quarter" is 2 points wherever they fall in time. The header tooltip ("last-quarter mean minus first-quarter mean") does not say which quarters. Not a chart, but it is a reported number. **Fix:** say "of its detected samples" or compute over the timeline.

### [L] `/api/sun-times` hard-codes `tz_offset: -7`

**Where:** `FastAPI/api/routes.py:281` (literal) vs `config.LOCATION_TZ_OFFSET` used by `astronomy.py`. The frontend ignores the field, so no effect today.

---

## Checked and found correct

**1. X axis / time zones.** `parseMMDDYY` (`format.ts:24`) takes `M/D/YY[ H:MM]`, 24-hour, unpadded, 2-digit year +2000; never goes through `new Date(string)`. Points and all night/day-band shapes are passed to Plotly as naive `"YYYY-MM-DD HH:MM:SS"` strings built with local getters (`toPlotlyDate`), never as epoch numbers, so Plotly's date axis shows PDT wall-clock for every viewer. Ran the full 4-h grid (135 strings, 27 May 13:00 → 18 Jun 21:00) through `parseDateTime → toPlotlyDate` and `isoDate` under 12 IANA zones (UTC, Asia/Tokyo, Asia/Kolkata, Pacific/Chatham +12:45, Australia/Lord_Howe +10:30, America/Sao_Paulo, Europe/London, Africa/Casablanca, America/Santiago, Asia/Tehran, Pacific/Apia, America/Los_Angeles): 0 mismatches, identical night-band edges. No IANA zone has a DST transition inside 27 May–18 Jun 2021, so the local-`Date` round trip cannot land in a gap. The 8–12 h sampling gaps are two real samples with a longer x-interval — drawn as a connected segment in all three charts (consistent; a date axis shows the gap as distance). A missing *detection* is an explicit null from the `/api/samples` union and `connectgaps:false` breaks the line, in all three charts (`EgcChart.tsx:139-167`, `MultiEgcChart.tsx:107-135`, `GroupedEgcChart.tsx:72-107`).

**2. Missing samples.** Null, never 0, never interpolated. Stats (`egcVals`) and the Z-score skip nulls. EgcChart header "N of 128 samples (detected in M)" — M is the non-null count in the visible window, which is exactly the number of markers drawn (nulls stay null through `applyLowess`). Analyze card mean = `seriesMeanOverSamples` over the samples the chart reports as visible (date range *and* Timepoints pills), shown as "n / visible-total samples"; Compare chip = `seriesMeanInRange` with the same inclusive `isoDate` rule `MultiEgcChart.baseRows` uses. Date filter: inclusive at both ends on bare dates, matching `index.is_within_date_range`.

**3. Sums.** `GroupedEgcChart` and `sumMembersByTimestamp` sum per datetime over detected members (absent member contributes nothing; sum is null only when no member is detected), hover says "k of N members detected", header says "(detected in N)". `norm_egc` is summed, which is valid (one shared per-sample denominator). Verified numerically: A{6/2: 10/0.1, 6/10: 20/0.2} + B{6/2: 1/0.01} → 6/2: 11/0.11, 6/10: 20/0.2. Nested members: Analyze groups drop ancestors/descendants before summing (`AnalyzePage.tsx:972 filterRedundantAnnotations`); Taxonomy remove/keep lines skip a checked branch nested under another checked branch (`utils/taxonomy.ts:26-38`, prefix rule with `;` delimiter) and use the root's own sample axis; Dataset Overview and Annotations-by-Parent groups are siblings under one parent (cross-group overlap for multi-parent KOs is by design and commented). Keying rows by datetime string is safe: `main.py:53` refuses to start if two samples share a timestamp.

**4. Z-score.** Population σ (÷n), confirmed: `[1,2,null,6]` → `[-0.92582, -0.46291, null, 1.38873]` (μ=3, σ=2.1602); n<2 returns the input unchanged and `canApplyZScore` removes the σ label/suffix; constant series → 0; applied after filtering and before LOWESS; applied to the *sum* for grouped series.

**5. LOWESS.** Span = max(3, ⌈bw·n⌉) with n = non-null visible points (bw 0.1 on 133 points → 14); x is epoch ms (real time), so an 8–12 h gap is not treated as one step; weighted *linear* fit centred on the query point (fitted value = intercept); tricube weights. The scale distance is the first strictly-farther point *outside* the window (so every included point has w > 0) — a documented departure from Cleveland's q-th-neighbour scaling, not an error. A straight line through a 12 h gap is reproduced to ≤ 3.9e-12 at bw 0.1/0.3/0.8; a constant to 1e-14; nulls kept in place. Stats in all three charts read the unsmoothed arrays; "(smoothed)" appears only in hover and the CSV flag.

**6. Descriptive statistics.** `computeStats` matches numpy exactly for an n=11 and an n=10 vector: mean, median, `std(ddof=1)`, `percentile(.., 25/75)` (linear = Type 7), CV. The even/odd median formula equals Type-7 at p=0.5. Computed over visible detected points; `n` is displayed.

**7. Day/night shading.** Backend "Almanac for Computers" (`astronomy.py`) vs an independent implementation of the NOAA solar-calculator spreadsheet equations for 48.65 N / −122.85 W, 26 May–19 Jun 2021: sunrise differs by +0.64 → −0.20 min, sunset by −0.30 → −0.11 min; max |Δ| = 0.64 min, under the 1-minute output resolution (`solar_check.py`). Fixed offset −7 h (PDT) is correct for the whole window. Frontend builds one band [sunset(N), sunrise(N+1)] from the day before the first sample to the last day, clipped to the data span; verified at the edges (first sample 27 May 13:00 → first band 27 May 21:05 → 28 May 05:10; last sample 18 Jun 21:00 → last band ends 18 Jun 05:10, the 18 Jun sunset band is correctly dropped). Sun "HH:MM" and tide "YYYY-MM-DD HH:MM" strings are parsed as local naive, same convention as the sample strings — no second shift. Hover sunrise/sunset per sample date via `resolveSunTimes`.

**8. Tide.** Shifted +1 h once, server-side (`cache.py:123`); frontend parses as-is. Units metres (`/api/tides.unit`, legend "meters", axis "Tide (m)"; the 2026-09-22 audit verified the values against NOAA live). Visual trace is the native 6-min series bounded to the visible span (on Analyze, also to the Timepoints pills); CSV column is the nearest reading within 30 min (verified: readings at 12:36 and 12:42 → 13:00 sample gets 12:42's value, 09:00 sample gets null). `yaxis2` overlays the right side with independent autorange.

**9. CSV export.** Columns and semantics as described under the hygiene finding; the value column is named after the metric and the `metric`/`standardized`/`smoothed` flags are per row (per series on Compare, reflecting whether the transform actually ran); Compare adds `detected`.

**10. Labels/legends/hover.** `getEgcYLabel`/`getEgcHoverYLabel` and the Multi/Grouped equivalents cover all four metric×Z combinations; "σ" suffix only when Z actually applied (per series on Compare); relative abundance shown as 3-s.f. percent; EGC as 3-s.f. exponent. Colours are resolved from CSS variables once and shared by trace and legend; grouped-series colours by position agree between `MultiEgcChart.resolvedColors` and Compare's `entryColor` (`groupSeriesColor(0)` = `var(--chart-group)` on both sides). No log axes anywhere; zeros plotted as values.

**11. Stale data / races.** Series caches are keyed by `annotation::source` (Analyze, Taxonomy); Compare matches responses to entries by id or `annotationId+source`; Explore guards with `requestSeqRef`/`chartSeqRef` and a `loadedParams` snapshot; `useAllSamples`/`useSolarTideData` hold a single in-flight promise. No path found where a chart can show a previous selection's data.

**12. Other.** `/series/annotations` has a 100-row default page size (`routes.py:523`), but every caller passes `page_size=500` (grep of `pages/*.tsx`). `minMeanMax` rounds the mean to one decimal, but is only used on integer scaffold/gene counts. `/annotations/top` groups in Dataset Overview are built from one parent each; the 40-member fetch cap is disclosed. `scaffoldChartData.ts` filters by `isoDate` and sorts by parsed time (correct for the unpadded strings).

## Not verifiable here

- No local database, `JGI_ID_Timepoints_128.csv` or `tides.csv`: the "no duplicate datetimes" and "tides in metres" statements rest on the startup assertion and on the 2026-09-22 live NOAA comparison, not on re-reading the files.
- Plotly's own rendering (jsdom has no canvas); the date-string handling is per Plotly's documented behaviour for naive date strings, not pixel-checked.
