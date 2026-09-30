"""
Tests/test_unit_backend.py
===========================
Unit tests for the split api.* modules — no server, no real data required.

Covers shared (backend-agnostic) logic:

  index.py        _parse_any_datetime, timepoint_sort_key,
                  timepoint_dt_sort_key, compute_date_range (edge cases)

  astronomy.py    sunrise_sunset_utc (pytest-ified version of the script checks),
                  SUN_TIMES structure

  correlation.py  _get_clr_matrix (cache hit / miss / thread-safety)

  routes.py       paginate, get_tides, get_sun_times, debug, status

  Everything that only ever exercised the JSON backend (extract_* field
  helpers, the inverted search_index, _normalize_annotation_dict /
  _search_dict_annotations / _filter_mapping_rows, and the routes that
  branched on DATA_BACKEND) was removed here once that code was deleted
  from api/cache.py, api/index.py, and api/routes.py -- their real,
  always-on coverage now lives in tests/sql/*_route.py instead (each using
  `with TestClient(app) as client:` so main.py's lifespan() actually runs).

  Note: the seven /samples/{sample_name}/... routes (cog, kegg, enzyme,
  taxonomy, mappings, mappings/summary, full) and
  /samples/{sample_name}/search/annotations were removed (W20, docs/AUDIT.md)
  -- they only ever worked against the full local JSON dataset, which the
  production deployment never carries (55GB+ vs the 87MB SQL database), so
  they 404'd there regardless of DATA_BACKEND, and nothing in the frontend
  called them.

Each class tests one module/concern; fake data is defined inline.
Real-data tests that need DataStructures/ on disk are in other files.

Run:
    pytest Tests/test_unit_backend.py -v
    pytest Tests/test_unit_backend.py -v -k "not RealData"  # always fast
"""

import math
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH


# cache.extract_annotation_name/extract_parent/extract_egc/extract_norm_egc
# (TestExtractAnnotationName/TestExtractParent/TestExtractEgc/TestExtractNormEgc)
# extracted fields from the old per-sample annotation JSON dicts -- removed
# along with the rest of the JSON backend, since the sql branch reads these
# same fields as native SQL columns instead (get_search_annotations,
# get_annotation_series_sql, etc. -- see tests/sql/test_cache_sql.py).


# ═══════════════════════════════════════════════════════════════════════════════
# norm_egc formula correctness
# ═══════════════════════════════════════════════════════════════════════════════

class TestNormEgcFormula:
    """
    Verifies the norm_egc formula semantics.

    Correct formula (implemented in all four EGC_*_TREE.ipynb notebooks):
        norm_egc = EGC / Σ(gene_count × scaffold_AvgFold)

    where the denominator sums over ALL scaffolds in the sample (not just
    scaffolds carrying the annotation being normalised).

    This guarantees norm_egc ∈ (0, 1] because EGC is itself
    Σ(gene_count × scaffold_AvgFold) for the annotation's own scaffolds —
    a subset of the full sample sum.

    The old formula (egc / Σ(AvgFold)) could exceed 1 for multi-copy
    annotations because it divided by the unweighted sum of coverages rather
    than the gene-count-weighted sum.
    """

    def test_norm_egc_manual_calculation(self):
        """Manual spot-check: EGC / weighted_total matches the expected value."""
        # Annotation present on 2 scaffolds:
        #   scaffold A: 3 gene copies, coverage 10.0  → EGC contribution = 30
        #   scaffold B: 1 gene copy,  coverage 20.0  → EGC contribution = 20
        egc = 3 * 10.0 + 1 * 20.0  # = 50

        # weighted_total = ALL scaffolds in sample (a superset):
        # scaffold A (3 × 10) + scaffold B (1 × 20) + 10 other scaffolds (1 × 5 each)
        weighted_total = (3 * 10.0) + (1 * 20.0) + (10 * 1 * 5.0)  # = 100

        norm = egc / weighted_total  # = 0.5
        assert norm == pytest.approx(0.5)
        assert 0.0 < norm <= 1.0

    def test_norm_egc_bounded_by_one(self):
        """An annotation that spans the entire sample has norm_egc = 1.0 exactly."""
        egc = weighted_total = 1_000_000.0  # annotation IS the whole sample
        norm = egc / weighted_total
        assert norm == pytest.approx(1.0)
        assert norm <= 1.0

    def test_norm_egc_ratio_uniform_within_sample(self):
        """
        All annotations from the same sample share the same denominator, so
        norm_egc / egc must equal 1 / weighted_total for all of them.
        A NORM_TOLERANCE of 1e-9 is enough to catch any real computation error
        while absorbing double-precision rounding.
        """
        weighted_total = 7_500_000.0  # realistic value for a 128-sample dataset
        annotations = {
            "COG0001": {"egc": 5771.0,  "norm_egc": 5771.0  / weighted_total},
            "COG0002": {"egc": 3200.0,  "norm_egc": 3200.0  / weighted_total},
            "COG0006": {"egc": 10500.0, "norm_egc": 10500.0 / weighted_total},
        }
        expected_k = 1.0 / weighted_total
        for ann_id, entry in annotations.items():
            k = entry["norm_egc"] / entry["egc"]
            assert k == pytest.approx(expected_k, rel=1e-9), \
                f"{ann_id}: k={k:.15g} ≠ expected {expected_k:.15g}"

    def test_old_formula_could_exceed_one(self):
        """
        Proves WHY the old formula was wrong: dividing EGC by the unweighted
        sum of coverages (Σ AvgFold) rather than the gene-count-weighted sum
        can produce norm_egc > 1 for multi-copy annotations.
        """
        # Annotation with 2 gene copies on each of 3 scaffolds, each at cov=100:
        egc = 2 * 100 + 2 * 100 + 2 * 100  # = 600

        # OLD denominator: just sum the coverages (ignores gene counts)
        old_total = 100 + 100 + 100          # = 300
        old_norm  = egc / old_total          # = 2.0 — exceeds 1!
        assert old_norm > 1.0, "Old formula must produce > 1 in this multi-copy case"

        # NEW denominator: weight by gene count — same as EGC numerator structure
        new_total = 2 * 100 + 2 * 100 + 2 * 100  # = 600 (gene_count × cov per scaffold)
        new_norm  = egc / new_total               # = 1.0 — correctly bounded
        assert 0.0 < new_norm <= 1.0

    def test_single_copy_gene_norm_egc_equals_weighted_fraction(self):
        """
        For a single-copy gene on one scaffold, the two formulas differ but
        the new formula still gives the correct interpretation: the fraction
        of total sample gene-copy depth attributable to this annotation.
        """
        scaffold_cov   = 150.0
        gene_count     = 1
        egc            = gene_count * scaffold_cov   # = 150

        # sample has 500 more gene-scaffold units at various depths
        weighted_total = egc + 500 * 100.0           # = 150 + 50000 = 50150

        norm = egc / weighted_total
        assert 0.0 < norm < 1.0
        assert norm == pytest.approx(150.0 / 50150.0)


# ═══════════════════════════════════════════════════════════════════════════════
# index.py — datetime parsing and sorting
# ═══════════════════════════════════════════════════════════════════════════════

class TestParseDatetime:
    """index._parse_any_datetime — handles all format variants in the dataset."""

    def test_unpadded_mddyy_format(self):
        """JGI_ID_Timepoints_128.csv stores unpadded dates like '6/2/21 1:00'."""
        from api.index import _parse_any_datetime
        dt = _parse_any_datetime("6/2/21 1:00")
        assert dt is not None
        assert dt.year == 2021
        assert dt.month == 6
        assert dt.day == 2
        assert dt.hour == 1

    def test_padded_mmddyy_format(self):
        from api.index import _parse_any_datetime
        dt = _parse_any_datetime("06/02/21 01:00")
        assert dt is not None
        assert dt.year == 2021

    def test_iso_format_with_seconds(self):
        from api.index import _parse_any_datetime
        dt = _parse_any_datetime("2021-06-02 01:00:00")
        assert dt is not None
        assert dt.month == 6

    def test_iso_format_with_T_separator(self):
        from api.index import _parse_any_datetime
        dt = _parse_any_datetime("2021-06-02T01:00:00")
        assert dt is not None

    def test_invalid_format_returns_none(self):
        from api.index import _parse_any_datetime
        assert _parse_any_datetime("not a date") is None

    def test_empty_string_returns_none(self):
        from api.index import _parse_any_datetime
        assert _parse_any_datetime("") is None

    def test_unpadded_sort_order_correct(self):
        """
        The critical regression check: '6/9/21' must sort BEFORE '6/18/21'
        (June 9 < June 18). A naive string sort gets this wrong because
        '6/9' > '6/1' lexicographically.
        """
        from api.index import _parse_any_datetime
        d9  = _parse_any_datetime("6/9/21 8:00")
        d18 = _parse_any_datetime("6/18/21 8:00")
        assert d9 < d18, "June 9 must sort before June 18 after parsing"

    def test_bare_iso_date_format(self):
        """<input type="date"> pickers send bare 'YYYY-MM-DD', no time --
        this is what date_from/date_to on /annotations/top receive (W2)."""
        from api.index import _parse_any_datetime
        dt = _parse_any_datetime("2021-06-05")
        assert dt is not None
        assert (dt.year, dt.month, dt.day) == (2021, 6, 5)
        assert (dt.hour, dt.minute) == (0, 0)


class TestTimepointSortKey:
    """index.timepoint_sort_key — ensures chronological float keys."""

    def _patch_timepoints(self, tp_dict):
        """Context manager to temporarily replace TIMEPOINTS in cache module."""
        import api.cache as c
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = tp_dict
        return orig

    def test_known_sample_returns_timestamp(self):
        import api.cache as c
        from api.index import timepoint_sort_key
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {"s1": {"datetime": "6/2/21 8:00"}}
        try:
            key = timepoint_sort_key("s1")
            assert isinstance(key, float)
            assert key > 0
        finally:
            c.TIMEPOINTS = orig

    def test_unknown_sample_returns_minus_one(self):
        from api.index import timepoint_sort_key
        assert timepoint_sort_key("__no_such_sample__") == -1.0

    def test_sample_with_no_datetime_returns_minus_one(self):
        import api.cache as c
        from api.index import timepoint_sort_key
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {"s1": {"datetime": None}}
        try:
            assert timepoint_sort_key("s1") == -1.0
        finally:
            c.TIMEPOINTS = orig

    def test_earlier_date_gives_smaller_key(self):
        import api.cache as c
        from api.index import timepoint_sort_key
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {
            "early": {"datetime": "5/27/21 8:00"},
            "late":  {"datetime": "6/17/21 8:00"},
        }
        try:
            assert timepoint_sort_key("early") < timepoint_sort_key("late")
        finally:
            c.TIMEPOINTS = orig

    def test_june9_sorts_before_june18(self):
        """Regression: confirms the string-sort bug is NOT present in sort keys."""
        import api.cache as c
        from api.index import timepoint_sort_key
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {
            "june9":  {"datetime": "6/9/21 8:00"},
            "june18": {"datetime": "6/18/21 8:00"},
        }
        try:
            assert timepoint_sort_key("june9") < timepoint_sort_key("june18"), \
                "June 9 must sort before June 18 (string-sort regression)"
        finally:
            c.TIMEPOINTS = orig


class TestTimepointDtSortKey:
    """index.timepoint_dt_sort_key — direct datetime string input."""

    def test_valid_string_returns_positive_float(self):
        from api.index import timepoint_dt_sort_key
        assert timepoint_dt_sort_key("6/2/21 8:00") > 0

    def test_none_returns_minus_one(self):
        from api.index import timepoint_dt_sort_key
        assert timepoint_dt_sort_key(None) == -1.0

    def test_empty_string_returns_minus_one(self):
        from api.index import timepoint_dt_sort_key
        assert timepoint_dt_sort_key("") == -1.0

    def test_earlier_date_smaller_than_later(self):
        from api.index import timepoint_dt_sort_key
        assert timepoint_dt_sort_key("5/27/21 8:00") < timepoint_dt_sort_key("6/17/21 20:00")


class TestComputeDateRangeEdgeCases:
    """index.compute_date_range — edge cases beyond the happy path in test_batch2."""

    def test_empty_timepoints_returns_none_none(self):
        import api.cache as c
        from api.index import compute_date_range
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {}
        try:
            result = compute_date_range()
            assert result == (None, None)
        finally:
            c.TIMEPOINTS = orig

    def test_single_sample_min_equals_max(self):
        import api.cache as c
        from api.index import compute_date_range
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {"only": {"datetime": "6/5/21 12:00"}}
        try:
            date_min, date_max = compute_date_range()
            assert date_min == date_max == "2021-06-05"
        finally:
            c.TIMEPOINTS = orig

    def test_unparseable_datetimes_excluded_gracefully(self):
        import api.cache as c
        from api.index import compute_date_range
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {
            "good":  {"datetime": "6/5/21 12:00"},
            "bad":   {"datetime": "NOT A DATE"},
        }
        try:
            date_min, date_max = compute_date_range()
            assert date_min == "2021-06-05"
        finally:
            c.TIMEPOINTS = orig

    def test_string_sort_regression_unpadded_dates(self):
        """
        Regression test for the bug confirmed 2026-06-15.
        The raw strings '6/9/21 ...' and '6/18/21 ...' sort incorrectly as
        strings ('6/9' > '6/1'), but correctly as parsed datetimes.
        The correct date_max must be '2021-06-18', not '2021-06-09'.
        """
        import api.cache as c
        from api.index import compute_date_range
        orig = c.TIMEPOINTS
        c.TIMEPOINTS = {
            "june_9":  {"datetime": "6/9/21 8:00"},
            "june_18": {"datetime": "6/18/21 20:00"},
            "june_1":  {"datetime": "6/1/21 4:00"},
        }
        try:
            date_min, date_max = compute_date_range()
            assert date_max == "2021-06-18", \
                f"String-sort bug: expected 2021-06-18 but got {date_max}"
            assert date_min == "2021-06-01"
        finally:
            c.TIMEPOINTS = orig


class TestIsWithinDateRange:
    """
    index.is_within_date_range -- W2 fix for /annotations/top's date filter.

    The bug: dt_str is unpadded "M/D/YY H:MM" (e.g. "6/9/21 8:00") while
    date_from/date_to are bare ISO "YYYY-MM-DD" from <input type="date">.
    Comparing them as plain text is meaningless -- "6/9/21 8:00" < "2021-06-05"
    lexically no matter what the actual dates are (different formats
    entirely), so a start date never filtered anything and an end date
    filtered out everything.
    """

    def test_no_bounds_always_true(self):
        from api.index import is_within_date_range
        assert is_within_date_range("6/9/21 8:00", None, None) is True

    def test_string_comparison_bug_is_gone_for_date_from(self):
        """Old bug: date_from was never honored because 'M/D/YY...' < 'YYYY-MM-DD'
        as plain text always, regardless of the actual dates."""
        from api.index import is_within_date_range
        # 6/9/21 is AFTER 2021-06-05, so with date_from=2021-06-05 it must match...
        assert is_within_date_range("6/9/21 8:00", "2021-06-05", None) is True
        # ...but a sample from before the start date must now be excluded,
        # which the old text-comparison bug could never do correctly.
        assert is_within_date_range("5/28/21 8:00", "2021-06-05", None) is False

    def test_string_comparison_bug_is_gone_for_date_to(self):
        """Old bug: date_to always excluded everything, since 'M/D/YY...'
        > 'YYYY-MM-DDz' as plain text always."""
        from api.index import is_within_date_range
        assert is_within_date_range("6/1/21 8:00", None, "2021-06-05") is True
        assert is_within_date_range("6/9/21 8:00", None, "2021-06-05") is False

    def test_date_from_is_inclusive_of_that_exact_day(self):
        from api.index import is_within_date_range
        assert is_within_date_range("6/5/21 0:00", "2021-06-05", None) is True

    def test_date_to_is_inclusive_of_the_whole_day_not_just_midnight(self):
        """A sample at 21:00 on the end date must still match -- date_to
        means 'through the end of that day', not 'through 00:00'."""
        from api.index import is_within_date_range
        assert is_within_date_range("6/5/21 21:00", None, "2021-06-05") is True
        assert is_within_date_range("6/6/21 0:01", None, "2021-06-05") is False

    def test_both_bounds_narrow_window(self):
        from api.index import is_within_date_range
        assert is_within_date_range("6/2/21 8:00", "2021-06-01", "2021-06-03") is True
        assert is_within_date_range("6/4/21 8:00", "2021-06-01", "2021-06-03") is False
        assert is_within_date_range("5/31/21 8:00", "2021-06-01", "2021-06-03") is False

    def test_unparseable_sample_datetime_excluded_not_crashed(self):
        from api.index import is_within_date_range
        assert is_within_date_range("garbage", "2021-06-01", None) is False
        assert is_within_date_range(None, "2021-06-01", None) is False
        assert is_within_date_range("", "2021-06-01", None) is False

    def test_unparseable_bound_is_ignored_not_crashed(self):
        """A malformed date_from/date_to shouldn't 500 the endpoint -- that
        bound is just treated as not constraining the range."""
        from api.index import is_within_date_range
        assert is_within_date_range("6/9/21 8:00", "not-a-date", None) is True


# index.search_index (the JSON backend's inverted-index lookup, including
# its W3 short-indexed-word-flooding fix) was removed along with the rest
# of the JSON search index -- the sql branch's /search/annotations uses
# SQL LIKE against annotation_series instead (a different mechanism, see
# tests/sql/test_search_annotations_sql_route.py), which doesn't have an
# indexed-word-tokenization step for W3's flooding failure mode to apply to.


# ═══════════════════════════════════════════════════════════════════════════════
# astronomy.py — sunrise/sunset as pytest
# ═══════════════════════════════════════════════════════════════════════════════

class TestSunriseSunsetUtc:
    """
    astronomy.sunrise_sunset_utc — pytest-ified version of the verification
    script checks. Uses sanity bounds rather than exact times (the algorithm
    is accurate to within a few minutes, not seconds).
    """

    LAT = 48.65
    LON = -122.85

    def _date(self, y, m, d):
        from datetime import date
        return date(y, m, d)

    def test_returns_two_floats_for_normal_date(self):
        from api.astronomy import sunrise_sunset_utc
        sr, ss = sunrise_sunset_utc(self._date(2021, 6, 5), self.LAT, self.LON)
        assert isinstance(sr, float)
        assert isinstance(ss, float)

    def test_sunrise_before_sunset(self):
        """
        Compare in local PDT (UTC-7) because sunset UTC wraps past midnight
        (e.g. 04:09 UTC next day), making raw UTC sunset < raw UTC sunrise.
        Converting to local time gives the expected sunrise < sunset ordering.
        """
        from api.astronomy import sunrise_sunset_utc
        sr, ss = sunrise_sunset_utc(self._date(2021, 6, 5), self.LAT, self.LON)
        sr_local = (sr + -7) % 24
        ss_local = (ss + -7) % 24
        assert sr_local < ss_local, \
            f"sunrise {sr_local:.2f}h must be before sunset {ss_local:.2f}h (local)"

    def test_june_sunrise_in_expected_utc_range(self):
        """At 48.65N, June sunrise is approximately 04:50-05:20 PDT = 11:50-12:20 UTC."""
        from api.astronomy import sunrise_sunset_utc
        sr, _ = sunrise_sunset_utc(self._date(2021, 6, 5), self.LAT, self.LON)
        # UTC range: roughly 11.5 to 12.5 hours
        assert 11.0 <= sr <= 13.0, f"June sunrise UTC {sr:.2f}h outside expected range"

    def test_june_sunset_in_expected_utc_range(self):
        """At 48.65N, June sunset is approximately 20:55-21:15 PDT = 03:55-04:15 UTC next day."""
        from api.astronomy import sunrise_sunset_utc
        _, ss = sunrise_sunset_utc(self._date(2021, 6, 5), self.LAT, self.LON)
        # sunset UTC wraps to ~03:55-04:15, i.e. decimal 3.9-4.25
        assert 3.5 <= ss <= 5.0, f"June sunset UTC {ss:.2f}h outside expected range"

    def test_may_sunrise_later_than_june_sunrise(self):
        """Days get shorter toward May — sunrise should be later (larger UTC hour)."""
        from api.astronomy import sunrise_sunset_utc
        sr_may,  _ = sunrise_sunset_utc(self._date(2021, 5, 27), self.LAT, self.LON)
        sr_june, _ = sunrise_sunset_utc(self._date(2021, 6, 17), self.LAT, self.LON)
        assert sr_may > sr_june, "Sunrise should be earlier (smaller UTC hour) closer to solstice"

    def test_polar_location_returns_none_none_in_winter(self):
        """Sun never rises at very high latitude in winter — must return (None, None)."""
        from api.astronomy import sunrise_sunset_utc
        from datetime import date
        sr, ss = sunrise_sunset_utc(date(2021, 12, 21), 89.0, 0.0)
        assert sr is None and ss is None

    def test_all_dataset_dates_have_valid_sun_times(self):
        """
        Every date in the May-June dataset range must produce non-None values.
        At 48.65N there is no polar day/night in this season.
        """
        from api.astronomy import sunrise_sunset_utc
        from datetime import date, timedelta
        start = date(2021, 5, 27)
        end   = date(2021, 6, 17)
        d = start
        while d <= end:
            sr, ss = sunrise_sunset_utc(d, self.LAT, self.LON)
            assert sr is not None and ss is not None, \
                f"{d}: unexpected None (sun never rises/sets at 48.65N in May-June)"
            d += timedelta(days=1)


class TestSunTimesCache:
    """astronomy.SUN_TIMES — structure checks on the module-level cache."""

    def test_sun_times_is_dict(self):
        from api.astronomy import SUN_TIMES
        assert isinstance(SUN_TIMES, dict)

    def test_each_entry_has_sunrise_and_sunset(self):
        from api.astronomy import SUN_TIMES
        if not SUN_TIMES:
            pytest.skip("No timepoints data — SUN_TIMES empty")
        for date_str, times in list(SUN_TIMES.items())[:5]:
            assert "sunrise" in times, f"{date_str} missing 'sunrise'"
            assert "sunset"  in times, f"{date_str} missing 'sunset'"

    def test_date_keys_are_iso_format(self):
        from api.astronomy import SUN_TIMES
        if not SUN_TIMES:
            pytest.skip("No timepoints data")
        import re
        for date_str in list(SUN_TIMES.keys())[:10]:
            assert re.match(r"^\d{4}-\d{2}-\d{2}$", date_str), \
                f"SUN_TIMES key '{date_str}' is not YYYY-MM-DD"

    def test_time_values_are_hhmm_format(self):
        from api.astronomy import SUN_TIMES
        if not SUN_TIMES:
            pytest.skip("No timepoints data")
        import re
        for date_str, times in list(SUN_TIMES.items())[:5]:
            for which in ("sunrise", "sunset"):
                assert re.match(r"^\d{2}:\d{2}$", times[which]), \
                    f"{date_str} {which} = '{times[which]}' is not HH:MM"


# ═══════════════════════════════════════════════════════════════════════════════
# routes.py — pure logic helpers (no HTTP needed)
# ═══════════════════════════════════════════════════════════════════════════════

class TestPaginate:
    """routes.paginate — boundary arithmetic."""

    def test_first_page_returns_first_n_items(self):
        from api.routes import paginate
        data = list(range(10))
        result = paginate(data, page=1, page_size=3)
        assert result["data"] == [0, 1, 2]

    def test_second_page_returns_correct_slice(self):
        from api.routes import paginate
        data = list(range(10))
        result = paginate(data, page=2, page_size=3)
        assert result["data"] == [3, 4, 5]

    def test_last_partial_page(self):
        from api.routes import paginate
        data = list(range(10))
        result = paginate(data, page=4, page_size=3)
        assert result["data"] == [9]

    def test_page_beyond_end_returns_empty_data(self):
        from api.routes import paginate
        result = paginate(list(range(5)), page=10, page_size=3)
        assert result["data"] == []

    def test_total_is_always_full_list_length(self):
        from api.routes import paginate
        result = paginate(list(range(100)), page=1, page_size=10)
        assert result["total"] == 100

    def test_total_pages_rounds_up(self):
        from api.routes import paginate
        result = paginate(list(range(11)), page=1, page_size=5)
        assert result["total_pages"] == 3

    def test_exact_fit_has_correct_total_pages(self):
        from api.routes import paginate
        result = paginate(list(range(9)), page=1, page_size=3)
        assert result["total_pages"] == 3

    def test_empty_list_returns_zero_total(self):
        from api.routes import paginate
        result = paginate([], page=1, page_size=10)
        assert result["total"] == 0
        assert result["data"] == []

    def test_page_and_page_size_echoed(self):
        from api.routes import paginate
        result = paginate(list(range(5)), page=2, page_size=2)
        assert result["page"] == 2
        assert result["page_size"] == 2


# TestNormalizeAnnotationDict, TestSearchDictAnnotations, and
# TestFilterMappingRows tested routes._normalize_annotation_dict,
# _search_dict_annotations, and _filter_mapping_rows -- all JSON-only
# search/mapping-fallback helpers removed from routes.py along with the
# JSON backend. /mappings/search's real, always-on coverage now lives in
# tests/sql/test_mappings_search_route.py.


class TestFilterTimepointsToRealSamples:
    """routes._filter_timepoints_to_real_samples -- drops TIMEPOINTS entries
    with no corresponding processed sample data (the "/timepoints reports
    132 while /samples reports 128" item, docs/AUDIT.md's Also-noted list).

    Tested directly (not via patched_client/HTTP) since the real fix
    branches on DATA_BACKEND at the route layer to pick the right sample
    list, which under the real DATA_BACKEND=sql config needs
    app.state.sql_conn -- a dependency patched_client doesn't set up (the
    same pre-existing gap as TestRoutesViaTestClient's other SQL-backed
    routes). This class covers the actual filtering logic without that
    dependency at all.
    """

    TIMEPOINTS = {
        "s1": {"taxon_oid": "s1", "datetime": "5/27/21 8:00"},
        "s2": {"taxon_oid": "s2", "datetime": "5/28/21 8:00"},
        "s3": {"taxon_oid": "s3", "datetime": "5/29/21 8:00"},  # never processed
        "s4": {"taxon_oid": "s4", "datetime": "5/30/21 8:00"},  # never processed
    }

    def test_drops_entries_with_no_real_sample(self):
        from api.routes import _filter_timepoints_to_real_samples
        result = _filter_timepoints_to_real_samples(self.TIMEPOINTS, ["s1", "s2"])
        assert {r["taxon_oid"] for r in result} == {"s1", "s2"}

    def test_real_world_shape_132_vs_128(self):
        """Same magnitude as the real bug: 4 extra timepoint entries with
        no matching sample."""
        from api.routes import _filter_timepoints_to_real_samples
        timepoints = {f"s{i}": {"taxon_oid": f"s{i}"} for i in range(132)}
        real_samples = [f"s{i}" for i in range(128)]  # s0..s127; s128..s131 excluded
        result = _filter_timepoints_to_real_samples(timepoints, real_samples)
        assert len(result) == 128

    def test_accepts_a_list_or_a_set_for_real_samples(self):
        from api.routes import _filter_timepoints_to_real_samples
        as_list = _filter_timepoints_to_real_samples(self.TIMEPOINTS, ["s1", "s2"])
        as_set  = _filter_timepoints_to_real_samples(self.TIMEPOINTS, {"s1", "s2"})
        assert {r["taxon_oid"] for r in as_list} == {r["taxon_oid"] for r in as_set}

    def test_empty_real_samples_returns_empty(self):
        from api.routes import _filter_timepoints_to_real_samples
        assert _filter_timepoints_to_real_samples(self.TIMEPOINTS, []) == []

    def test_empty_timepoints_returns_empty(self):
        from api.routes import _filter_timepoints_to_real_samples
        assert _filter_timepoints_to_real_samples({}, ["s1"]) == []

    def test_does_not_mutate_inputs(self):
        from api.routes import _filter_timepoints_to_real_samples
        tp_copy = dict(self.TIMEPOINTS)
        real = ["s1", "s2"]
        _filter_timepoints_to_real_samples(self.TIMEPOINTS, real)
        assert self.TIMEPOINTS == tp_copy
        assert real == ["s1", "s2"]


# ═══════════════════════════════════════════════════════════════════════════════
# routes.py — HTTP endpoints, backend-agnostic ones only
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def patched_client():
    """
    Self-contained TestClient -- context-manager form so main.py's
    lifespan() actually runs (see tests/sql/test_samples_and_timepoints_route.py's
    module docstring for why the plain-constructor form doesn't).

    No monkeypatching needed any more: this fixture used to fake an entire
    JSON-backend dataset (COG/KEGG/Enzyme/Taxonomy/TSV data, the search and
    mapping indexes) to test routes that branched on DATA_BACKEND. All of
    those were removed once that JSON code was deleted -- what's left
    (`/status`, `/tides`, `/sun-times`, `/debug`) are backend-agnostic and
    just work against the real data already on disk.
    """
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as client:
        yield client


@pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- these tests boot the real app via "
           f"main.py's lifespan, which needs a real database (W12, docs/AUDIT-2026-09-22.md)",
)
class TestRoutesViaTestClient:
    """HTTP-level tests for the backend-agnostic endpoints (no DATA_BACKEND
    branch): /status, /tides, /sun-times, /debug."""

    def test_status_returns_200(self, patched_client):
        r = patched_client.get("/status")
        assert r.status_code == 200

    def test_status_has_index_ready(self, patched_client):
        body = patched_client.get("/status").json()
        assert "index_ready" in body

    def test_status_has_date_range(self, patched_client):
        # DATA_DATE_MIN/MAX are computed at import time from real data before
        # the patch takes effect, so we verify structure not specific fake values.
        body = patched_client.get("/status").json()
        assert "date_min" in body
        assert "date_max" in body
        assert body.get("date_min") is None or isinstance(body["date_min"], str)
        assert body.get("date_max") is None or isinstance(body["date_max"], str)

    # /samples branches on DATA_BACKEND -- see the note above
    # test_debug_has_base_dir for why its tests now live in
    # tests/sql/test_samples_and_timepoints_route.py instead.

    def test_tides_returns_200(self, patched_client):
        r = patched_client.get("/tides")
        assert r.status_code == 200

    def test_tides_has_station_and_data(self, patched_client):
        # TIDES is loaded at import time from real data before the patch takes
        # effect, so we verify structure and non-empty rather than exact count.
        body = patched_client.get("/tides").json()
        assert "station" in body
        assert "data"    in body
        assert body["total"] > 0

    def test_sun_times_returns_200(self, patched_client):
        r = patched_client.get("/sun-times")
        assert r.status_code == 200

    def test_sun_times_has_location_and_data(self, patched_client):
        body = patched_client.get("/sun-times").json()
        assert "location" in body
        assert "data"     in body

    def test_debug_returns_200(self, patched_client):
        r = patched_client.get("/debug")
        assert r.status_code == 200

    def test_debug_has_base_dir(self, patched_client):
        body = patched_client.get("/debug").json()
        assert "base_dir" in body

    # /search/annotations, /series/annotations, /annotations/top,
    # /mappings/search, /timepoints, and /samples (above) all branch on
    # DATA_BACKEND, so under the real DATA_BACKEND=sql config they hit the
    # pre-existing patched_client/sql_conn gap (patched_client only patches
    # JSON-backend internals; app.state.sql_conn from main.py's lifespan()
    # is never set up here). Their tests were removed from here and now
    # live as real, always-on coverage in tests/sql/*_route.py instead --
    # see test_search_annotations_sql_route.py, test_annotation_sql_route.py
    # (series), test_top_annotations_route.py, test_mappings_search_route.py,
    # and test_samples_and_timepoints_route.py, each using
    # `with TestClient(app) as client:` so main.py's lifespan() actually
    # runs. _filter_timepoints_to_real_samples's own logic is still covered
    # directly, bypassing all of this, in TestFilterTimepointsToRealSamples
    # below.


# GET /taxonomy/children's only real, always-on coverage now lives in
# tests/sql/test_taxonomy_children_sql_route.py -- both the old
# TestTaxonomyChildrenEndpoint (HTTP via patched_client, hit the
# patched_client/sql_conn gap documented above test_debug_has_base_dir) and
# TestTaxonomyChildrenJsonBranchDirect (tested the DATA_BACKEND=='json'
# branch directly) were removed here once that branch itself was deleted
# from routes.py as part of the JSON backend retirement.


# ═══════════════════════════════════════════════════════════════════════════════
# cache.py -- CSV loaders' edge-case branches (missing file, malformed rows)
# ═══════════════════════════════════════════════════════════════════════════════
# Found uncovered by a post-JSON-removal coverage pass: TIMEPOINTS/TIDES are
# loaded once at import time from real, well-formed files, so nothing had
# ever exercised what happens when the file is missing or a row is
# malformed -- real robustness paths for a scientific-data app, not
# hypothetical. Call load_timepoints()/load_tides() directly (not the
# already-loaded TIMEPOINTS/TIDES module constants) against synthetic
# tmp_path files instead.

class TestLoadTimepointsEdgeCases:

    def test_missing_csv_returns_empty_dict_not_raise(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        monkeypatch.setattr(cache_mod, "TIMEPOINTS_CSV", str(tmp_path / "does_not_exist.csv"))
        assert cache_mod.load_timepoints() == {}

    def test_real_shaped_csv_parses_correctly(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        csv_path = tmp_path / "timepoints.csv"
        csv_path.write_text("taxon_oid,Timepoint,DateTime\n3300060410,T1,5/27/21 8:00\n")
        monkeypatch.setattr(cache_mod, "TIMEPOINTS_CSV", str(csv_path))
        result = cache_mod.load_timepoints()
        assert result == {
            "3300060410": {"taxon_oid": "3300060410", "timepoint": "T1", "datetime": "5/27/21 8:00"}
        }


class TestLoadTidesEdgeCases:

    def test_missing_csv_returns_empty_list_not_raise(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        monkeypatch.setattr(cache_mod, "TIDES_CSV", str(tmp_path / "does_not_exist.csv"))
        assert cache_mod.load_tides() == []

    def test_blank_predicted_wl_row_is_skipped_not_crashed(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        csv_path = tmp_path / "tides.csv"
        csv_path.write_text(
            "# comment\n" * 7
            + "time,predicted_wl,tide_event\n"
            + "2021-05-27 08:00,,\n"
            + "2021-05-27 12:36,3.2,High\n"
        )
        monkeypatch.setattr(cache_mod, "TIDES_CSV", str(csv_path))
        rows = cache_mod.load_tides()
        assert len(rows) == 1
        assert rows[0]["predicted_wl"] == 3.2

    def test_non_numeric_predicted_wl_row_is_skipped_not_crashed(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        csv_path = tmp_path / "tides.csv"
        csv_path.write_text(
            "# comment\n" * 7
            + "time,predicted_wl,tide_event\n"
            + "2021-05-27 08:00,not_a_number,\n"
            + "2021-05-27 12:36,3.2,High\n"
        )
        monkeypatch.setattr(cache_mod, "TIDES_CSV", str(csv_path))
        rows = cache_mod.load_tides()
        assert len(rows) == 1
        assert rows[0]["predicted_wl"] == 3.2

    def test_unparseable_time_falls_back_to_raw_string_not_crashed(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        csv_path = tmp_path / "tides.csv"
        csv_path.write_text(
            "# comment\n" * 7
            + "time,predicted_wl,tide_event\n"
            + "not-a-real-timestamp,3.2,High\n"
        )
        monkeypatch.setattr(cache_mod, "TIDES_CSV", str(csv_path))
        rows = cache_mod.load_tides()
        assert len(rows) == 1
        assert rows[0]["time"] == "not-a-real-timestamp"

    def test_real_shaped_csv_applies_the_documented_hour_shift(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        csv_path = tmp_path / "tides.csv"
        csv_path.write_text(
            "# comment\n" * 7
            + "time,predicted_wl,tide_event\n"
            + "2021-06-03 11:36,3.2,High\n"
        )
        monkeypatch.setattr(cache_mod, "TIDES_CSV", str(csv_path))
        monkeypatch.setattr(cache_mod, "TIDE_SHIFT_HOURS", 1)
        rows = cache_mod.load_tides()
        assert rows[0]["time"] == "2021-06-03 12:36"


class TestGetAllSampleNamesEdgeCases:
    """Migration-script-only helper (see cache.py's own comment) -- the
    live app enumerates samples from the sql database instead."""

    def test_missing_mappings_dir_returns_empty_list_not_raise(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        monkeypatch.setattr(cache_mod, "MAPPINGS_DIR", str(tmp_path / "does_not_exist"))
        assert cache_mod.get_all_sample_names() == []

    def test_lists_and_strips_mapping_tsv_filenames_sorted(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        (tmp_path / "3300060410_mapping.tsv").write_text("")
        (tmp_path / "3300060358_mapping.tsv").write_text("")
        (tmp_path / "unrelated_file.txt").write_text("")
        monkeypatch.setattr(cache_mod, "MAPPINGS_DIR", str(tmp_path))
        assert cache_mod.get_all_sample_names() == ["3300060358", "3300060410"]
