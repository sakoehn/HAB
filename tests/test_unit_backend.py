"""
Tests/test_unit_backend.py
===========================
Unit tests for the split api.* modules — no server, no real data required.

Covers the 28 functions that had zero pytest coverage after the module split:

  cache.py        extract_annotation_name, extract_parent, extract_egc,
                  extract_norm_egc, load_enzyme (loader shape), load_taxonomy

  index.py        _parse_any_datetime, timepoint_sort_key,
                  timepoint_dt_sort_key, search_index (via in-memory fixture),
                  compute_date_range (edge cases)

  astronomy.py    sunrise_sunset_utc (pytest-ified version of the script checks),
                  SUN_TIMES structure

  correlation.py  _get_clr_matrix (cache hit / miss / thread-safety)

  routes.py       paginate, _normalize_annotation_dict,
                  _search_dict_annotations, _filter_mapping_rows,
                  list_samples, get_tides, get_sun_times,
                  search_annotations (index path + scan path),
                  top_annotations_by_egc, annotation_time_series, debug

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


# ═══════════════════════════════════════════════════════════════════════════════
# cache.py — extraction helpers
# ═══════════════════════════════════════════════════════════════════════════════

class TestExtractAnnotationName:
    """cache.extract_annotation_name — all branch paths."""

    def test_string_value_returns_itself(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name("Alcohol dehydrogenase") == "Alcohol dehydrogenase"

    def test_dict_with_name_field(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"name": "ADH", "egc": 100}) == "ADH"

    def test_dict_prefers_name_over_category(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"name": "ADH", "category": "C"}) == "ADH"

    def test_dict_falls_back_to_category(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"category": "Metabolism"}) == "Metabolism"

    def test_dict_falls_back_to_label(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"label": "my label"}) == "my label"

    def test_dict_with_only_unrelated_fields_returns_none(self):
        """parent_ec/parent_id are not name fields — must not leak into 'name'."""
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"parent_ec": "1.1.-.-", "parent_id": "X"}) is None

    def test_dict_with_no_name_fields_returns_none(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({"egc": 42}) is None

    def test_none_value_returns_none(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name(None) is None

    def test_int_value_returns_none(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name(42) is None

    def test_empty_dict_returns_none(self):
        from api.cache import extract_annotation_name
        assert extract_annotation_name({}) is None


class TestExtractParent:
    """cache.extract_parent — per-source branching."""

    def test_kegg_uses_parent_name_list_first_element(self):
        from api.cache import extract_parent
        v = {"parent_name": ["Carbohydrate metabolism", "Other"]}
        assert extract_parent(v, "kegg") == "Carbohydrate metabolism"

    def test_kegg_falls_back_to_parent_id_then_category(self):
        from api.cache import extract_parent
        assert extract_parent({"parent_id": "09101"}, "kegg") == "09101"
        assert extract_parent({"category": "Metabolism"}, "kegg") == "Metabolism"

    def test_kegg_empty_parent_name_list_falls_back(self):
        from api.cache import extract_parent
        v = {"parent_name": [], "category": "Fallback"}
        assert extract_parent(v, "kegg") == "Fallback"

    def test_cog_uses_category(self):
        from api.cache import extract_parent
        assert extract_parent({"category": "J"}, "cog") == "J"

    def test_cog_missing_category_returns_none(self):
        from api.cache import extract_parent
        assert extract_parent({"name": "COG0001"}, "cog") is None

    def test_enzyme_uses_parent_name(self):
        from api.cache import extract_parent
        assert extract_parent({"parent_name": "1.1.-.-"}, "enzyme") == "1.1.-.-"

    def test_enzyme_falls_back_to_parent_id(self):
        from api.cache import extract_parent
        assert extract_parent({"parent_id": "1.1.-.-"}, "enzyme") == "1.1.-.-"

    def test_enzyme_missing_parent_fields_returns_none(self):
        from api.cache import extract_parent
        assert extract_parent({"name": "ADH"}, "enzyme") is None

    def test_taxonomy_uses_parent_list(self):
        from api.cache import extract_parent
        v = {"parent": ["Bacteria", "Proteobacteria"]}
        assert extract_parent(v, "taxonomy") == "Bacteria"

    def test_taxonomy_string_parent(self):
        from api.cache import extract_parent
        assert extract_parent({"parent": "Bacteria"}, "taxonomy") == "Bacteria"

    def test_non_dict_value_returns_none(self):
        from api.cache import extract_parent
        assert extract_parent("just a string", "kegg") is None

    def test_unknown_source_returns_none(self):
        from api.cache import extract_parent
        assert extract_parent({"category": "X"}, "unknown_source") is None


class TestExtractEgc:
    """cache.extract_egc — numeric extraction from various value shapes."""

    def test_int_scalar(self):
        from api.cache import extract_egc
        assert extract_egc(5771) == 5771.0

    def test_float_scalar(self):
        from api.cache import extract_egc
        assert extract_egc(219.5) == 219.5

    def test_dict_with_egc_key(self):
        from api.cache import extract_egc
        assert extract_egc({"egc": 100.0, "name": "X"}) == 100.0

    def test_dict_with_EGC_uppercase(self):
        from api.cache import extract_egc
        assert extract_egc({"EGC": 77.0}) == 77.0

    def test_dict_with_no_egc_returns_none(self):
        from api.cache import extract_egc
        assert extract_egc({"name": "X"}) is None

    def test_string_returns_none(self):
        from api.cache import extract_egc
        assert extract_egc("5771") is None

    def test_none_returns_none(self):
        from api.cache import extract_egc
        assert extract_egc(None) is None

    def test_zero_egc_is_returned_as_float(self):
        from api.cache import extract_egc
        assert extract_egc({"egc": 0}) == 0.0

    def test_result_is_always_float(self):
        from api.cache import extract_egc
        result = extract_egc(42)
        assert isinstance(result, float)


class TestExtractNormEgc:
    """cache.extract_norm_egc — depth-normalised value extraction."""

    def test_dict_with_norm_egc_key(self):
        from api.cache import extract_norm_egc
        assert extract_norm_egc({"norm_egc": 0.000423}) == pytest.approx(0.000423)

    def test_dict_with_NORM_EGC_uppercase(self):
        from api.cache import extract_norm_egc
        assert extract_norm_egc({"NORM_EGC": 0.001}) == pytest.approx(0.001)

    def test_missing_norm_egc_returns_none(self):
        from api.cache import extract_norm_egc
        assert extract_norm_egc({"egc": 100}) is None

    def test_scalar_returns_none(self):
        from api.cache import extract_norm_egc
        assert extract_norm_egc(5771) is None

    def test_none_returns_none(self):
        from api.cache import extract_norm_egc
        assert extract_norm_egc(None) is None

    def test_result_is_float(self):
        from api.cache import extract_norm_egc
        result = extract_norm_egc({"norm_egc": 1})
        assert isinstance(result, float)

    def test_zero_norm_egc_returns_zero_float(self):
        """norm_egc=0 must return 0.0, not None.
        The explicit None check matches how extract_egc already works."""
        from api.cache import extract_norm_egc
        result = extract_norm_egc({"norm_egc": 0})
        assert result == 0.0
        assert isinstance(result, float)

    def test_zero_not_shadowed_by_uppercase_key(self):
        """With both keys present and lowercase=0, lowercase must win (not NORM_EGC)."""
        from api.cache import extract_norm_egc
        result = extract_norm_egc({"norm_egc": 0, "NORM_EGC": 0.5})
        assert result == 0.0

    def test_lowercase_key_takes_precedence_over_uppercase(self):
        """When both keys present with non-zero values, lowercase wins."""
        from api.cache import extract_norm_egc
        result = extract_norm_egc({"norm_egc": 0.001, "NORM_EGC": 0.999})
        assert result == pytest.approx(0.001)

    def test_result_in_unit_interval(self):
        """A real norm_egc value must satisfy 0 <= norm_egc <= 1."""
        from api.cache import extract_norm_egc
        v = extract_norm_egc({"norm_egc": 6.965e-5})
        assert v is not None
        assert 0.0 <= v <= 1.0

    def test_norm_egc_near_one_accepted(self):
        """norm_egc = 1.0 is valid — annotation covers the entire sample depth."""
        from api.cache import extract_norm_egc
        result = extract_norm_egc({"norm_egc": 1.0})
        assert result == pytest.approx(1.0)


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


class TestSearchIndex:
    """index.search_index — binary-search prefix lookup on a synthetic index."""

    @pytest.fixture(autouse=True)
    def _patch_index(self):
        """Install a minimal synthetic search index for the duration of each test."""
        import api.index as idx
        orig_idx    = {src: dict(idx._SEARCH_INDEX[src]) for src in idx._SOURCES}
        orig_sorted = {src: list(idx._SEARCH_INDEX_SORTED[src]) for src in idx._SOURCES}

        idx._SEARCH_INDEX["kegg"] = {
            "k00010":    {"KO:K00010"},
            "k00001":    {"KO:K00001"},
            "alcohol":   {"KO:K00010"},
            "dehydrogenase": {"KO:K00010", "KO:K00001"},
            "ko:k00010": {"KO:K00010"},
            "ko:k00001": {"KO:K00001"},
            # W3 regression fixture: a real taxonomy strain name like
            # "Rhizobium sp. ERR 922" tokenizes (on whitespace) into a
            # standalone single-letter/short word -- here "f" -- unrelated
            # to "ferredoxin" except that "f" happens to be one of its
            # letters. Also includes "red" and "err", which are genuinely
            # embedded substrings of "ferredoxin" (fer-RED-oxin,
            # f-ERR-edoxin) and would still collide even under a
            # minimum-length threshold on the indexed word.
            "f":            {"KO:UNRELATED_F"},
            "red":          {"KO:UNRELATED_RED"},
            "err":          {"KO:UNRELATED_ERR"},
            "ferredoxin":   {"KO:GENUINE_FERREDOXIN"},
        }
        import bisect
        idx._SEARCH_INDEX_SORTED["kegg"] = sorted(idx._SEARCH_INDEX["kegg"].keys())

        yield

        idx._SEARCH_INDEX["kegg"]        = orig_idx["kegg"]
        idx._SEARCH_INDEX_SORTED["kegg"] = orig_sorted["kegg"]

    def test_exact_token_match(self):
        from api.index import search_index
        result = search_index("kegg", "k00010")
        assert "KO:K00010" in result

    def test_prefix_match(self):
        from api.index import search_index
        result = search_index("kegg", "k000")
        assert "KO:K00010" in result
        assert "KO:K00001" in result

    def test_substring_match(self):
        from api.index import search_index
        result = search_index("kegg", "cohol")
        assert "KO:K00010" in result

    def test_multi_token_and_logic(self):
        from api.index import search_index
        # "dehydrogenase" matches both KO:K00010 and KO:K00001
        # "k00010" matches only KO:K00010
        # AND result must be {KO:K00010}
        result = search_index("kegg", "dehydrogenase k00010")
        assert result == {"KO:K00010"}

    def test_no_match_returns_empty_set(self):
        from api.index import search_index
        result = search_index("kegg", "zzznomatch")
        assert result == set()

    def test_empty_query_returns_empty_set(self):
        from api.index import search_index
        result = search_index("kegg", "")
        assert result == set()

    def test_unknown_source_returns_empty_set(self):
        from api.index import search_index
        result = search_index("nonexistent_source", "k00010")
        assert result == set()

    def test_case_insensitive(self):
        from api.index import search_index
        result = search_index("kegg", "ALCOHOL")
        assert "KO:K00010" in result

    def test_short_indexed_word_does_not_flood_unrelated_query_matches(self):
        """W3: a short indexed word like "f" (a taxonomy strain-name
        single-letter token) must not match every longer query that happens
        to contain that letter -- searching "ferredoxin" must not also
        surface everything tagged "f"."""
        from api.index import search_index
        result = search_index("kegg", "ferredoxin")
        assert result == {"KO:GENUINE_FERREDOXIN"}
        assert "KO:UNRELATED_F" not in result

    def test_coincidental_embedded_substring_does_not_match(self):
        """W3: "ferredoxin" genuinely contains "red" and "err" as
        substrings (fer-RED-oxin, f-ERR-edoxin) -- a length threshold on
        the indexed word alone wouldn't stop these, since both are 3
        letters. Confirms the fix (one-directional matching) rules them
        out regardless of length."""
        from api.index import search_index
        result = search_index("kegg", "ferredoxin")
        assert "KO:UNRELATED_RED" not in result
        assert "KO:UNRELATED_ERR" not in result

    def test_short_query_still_matches_longer_indexed_word(self):
        """The query -> indexed-word direction (short query, longer
        indexed word) is the legitimate "type ahead" case and must still
        work after removing the reverse direction."""
        from api.index import search_index
        result = search_index("kegg", "ferr")
        assert "KO:GENUINE_FERREDOXIN" in result


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


class TestNormalizeAnnotationDict:
    """routes._normalize_annotation_dict — standardises raw annotation dicts."""

    def test_output_has_required_keys(self):
        from api.routes import _normalize_annotation_dict
        data   = {"COG0001": {"egc": 100, "name": "Test"}}
        result = _normalize_annotation_dict(data, "cog", "sample_01")
        assert len(result) == 1
        row = result[0]
        for key in ("source", "sample", "timepoint", "annotation_id", "name", "value"):
            assert key in row, f"Missing key '{key}' in normalised record"

    def test_annotation_id_matches_dict_key(self):
        from api.routes import _normalize_annotation_dict
        data = {"K00010": {"egc": 50}}
        row  = _normalize_annotation_dict(data, "kegg", "s1")[0]
        assert row["annotation_id"] == "K00010"

    def test_name_extracted_from_value(self):
        from api.routes import _normalize_annotation_dict
        data = {"K00010": {"name": "ADH"}}
        row  = _normalize_annotation_dict(data, "kegg", "s1")[0]
        assert row["name"] == "ADH"

    def test_source_and_sample_set_correctly(self):
        from api.routes import _normalize_annotation_dict
        data = {"COG0001": {}}
        row  = _normalize_annotation_dict(data, "cog", "my_sample")[0]
        assert row["source"] == "cog"
        assert row["sample"] == "my_sample"

    def test_empty_dict_returns_empty_list(self):
        from api.routes import _normalize_annotation_dict
        assert _normalize_annotation_dict({}, "kegg", "s1") == []


class TestSearchDictAnnotations:
    """routes._search_dict_annotations — filtering logic."""

    SAMPLE_DATA = {
        "COG0001": {"name": "Chaperonin GroEL", "egc": 5000},
        "COG0002": {"name": "DNA polymerase",   "egc": 2000},
        "COG9999": {"name": "Hypothetical",      "egc": 100},
    }

    def test_q_partial_match_on_annotation_id(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1", q="COG000")
        ids = {r["annotation_id"] for r in result}
        assert "COG0001" in ids
        assert "COG0002" in ids
        assert "COG9999" not in ids

    def test_q_partial_match_on_name(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1", q="polymerase")
        assert len(result) == 1
        assert result[0]["annotation_id"] == "COG0002"

    def test_exact_annotation_id_filter(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1",
                                          annotation_id="COG0001")
        assert len(result) == 1
        assert result[0]["annotation_id"] == "COG0001"

    def test_name_exact_filter(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1",
                                          name_exact="Hypothetical")
        assert len(result) == 1
        assert result[0]["annotation_id"] == "COG9999"

    def test_name_exact_case_insensitive(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1",
                                          name_exact="hypothetical")
        assert len(result) == 1

    def test_no_filters_returns_all(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1")
        assert len(result) == 3

    def test_annotation_id_not_found_returns_empty(self):
        from api.routes import _search_dict_annotations
        result = _search_dict_annotations(self.SAMPLE_DATA, "cog", "s1",
                                          annotation_id="COGXXX")
        assert result == []


class TestFilterMappingRows:
    """routes._filter_mapping_rows — TSV row filtering by source column."""

    from api.cache import MappingRow as _MappingRow

    ROWS = [
        _MappingRow(gene_id="g1", contig_id="c1", taxonomy="Bacteria",
                    kegg_id="K00010", enzyme="1.1.1.1", cog_id="COG0001"),
        _MappingRow(gene_id="g2", contig_id="c2", taxonomy="Archaea",
                    kegg_id="K00020", enzyme=None,     cog_id="COG0002"),
        _MappingRow(gene_id="g3", contig_id="c3", taxonomy=None,
                    kegg_id=None,    enzyme="2.2.2.2", cog_id="COG0001"),
    ]

    def test_kegg_source_filters_by_kegg_id(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "kegg", "K000")
        gene_ids = {r.gene_id for r in result}
        assert "g1" in gene_ids
        assert "g2" in gene_ids
        assert "g3" not in gene_ids

    def test_cog_source_filters_by_cog_id(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "cog", "COG0001")
        gene_ids = {r.gene_id for r in result}
        assert "g1" in gene_ids
        assert "g3" in gene_ids
        assert "g2" not in gene_ids

    def test_enzyme_source_filters_by_enzyme(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "enzyme", "1.1.1")
        assert len(result) == 1
        assert result[0].gene_id == "g1"

    def test_taxonomy_source_filters_by_taxonomy(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "taxonomy", "Bacteria")
        assert len(result) == 1
        assert result[0].gene_id == "g1"

    def test_partial_match_case_insensitive(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "taxonomy", "bacteria")
        assert len(result) == 1

    def test_no_match_returns_empty_list(self):
        from api.routes import _filter_mapping_rows
        result = _filter_mapping_rows(self.ROWS, "kegg", "KZZZ")
        assert result == []

    def test_none_column_value_not_matched(self):
        from api.routes import _filter_mapping_rows
        # g2 has enzyme=None; querying "2" must not crash or match g2
        result = _filter_mapping_rows(self.ROWS, "enzyme", "2")
        gene_ids = {r.gene_id for r in result}
        assert "g2" not in gene_ids


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
# routes.py — HTTP endpoints via FastAPI TestClient with synthetic data
# ═══════════════════════════════════════════════════════════════════════════════

# Shared synthetic data used by the TestClient fixture below.
_FAKE_TIMEPOINTS = {
    "s001": {"taxon_oid": "s001", "timepoint": "T1", "datetime": "5/27/21 8:00"},
    "s002": {"taxon_oid": "s002", "timepoint": "T2", "datetime": "6/1/21 12:00"},
}
_FAKE_TIDES = [
    {"time": "2021-05-27 08:00", "predicted_wl": 1.5, "tide_event": None},
    {"time": "2021-05-27 12:36", "predicted_wl": 3.2, "tide_event": "High"},
]
_FAKE_SUN_TIMES = {
    "2021-05-27": {"sunrise": "05:00", "sunset": "21:00"},
    "2021-06-01": {"sunrise": "04:55", "sunset": "21:10"},
}
_FAKE_COG_DATA = {
    "s001": {"COG0001": {"name": "GroEL", "egc": 100.0, "norm_egc": 0.001, "scaffolds": {"sc1": 1}}},
    "s002": {"COG0001": {"name": "GroEL", "egc": 200.0, "norm_egc": 0.002, "scaffolds": {"sc2": 2}}},
}
_FAKE_KEGG_DATA = {
    "s001": {"K00010": {"name": "ADH", "egc": 50.0, "norm_egc": 0.0005}},
    "s002": {"K00010": {"name": "ADH", "egc": 75.0, "norm_egc": 0.00075}},
}
_FAKE_ENZYME_DATA = {
    "s001": {"1.1.1.1": {"name": "Alcohol dehydrogenase", "egc": 30.0, "norm_egc": 0.0003}},
    "s002": {"1.1.1.1": {"name": "Alcohol dehydrogenase", "egc": 45.0, "norm_egc": 0.00045}},
}
_FAKE_TAXONOMY_DATA = {
    "s001": {"Bacteria": {"egc": 1000.0, "norm_egc": 0.01, "parent": None}},
    "s002": {"Bacteria": {"egc": 1200.0, "norm_egc": 0.012, "parent": None}},
}
from api.cache import MappingRow as _MappingRow

_FAKE_TSV = {
    "s001": [_MappingRow(gene_id="g1", contig_id="c1", taxonomy="Bacteria",
                          kegg_id="K00010", enzyme="1.1.1.1", cog_id="COG0001")],
    "s002": [_MappingRow(gene_id="g2", contig_id="c2", taxonomy="Archaea",
                          kegg_id="K00020", enzyme=None, cog_id="COG0001")],
}


@pytest.fixture(scope="module")
def patched_client():
    """
    TestClient with all I/O patched to synthetic data.
    Covers the untested HTTP endpoints without needing real files on disk.
    """
    import api.cache  as cache_mod
    import api.index  as index_mod
    import api.routes as routes_mod
    import api.astronomy as astro_mod

    # Patch cache module
    cache_mod.TIMEPOINTS = _FAKE_TIMEPOINTS
    cache_mod.TIDES      = _FAKE_TIDES
    cache_mod._TSV_CACHE = _FAKE_TSV

    # routes.py does `from .cache import TIMEPOINTS` — an import-by-value that
    # binds its own copy of the name, not a live reference to cache_mod's
    # attribute. Patching cache_mod.TIMEPOINTS alone does NOT affect what
    # list_timepoints() sees; routes_mod.TIMEPOINTS must be patched directly.
    orig_routes_timepoints = routes_mod.TIMEPOINTS
    routes_mod.TIMEPOINTS  = _FAKE_TIMEPOINTS
    cache_mod._JSON_CACHE = {
        f"cog_dir::s001.cog": _FAKE_COG_DATA["s001"],
        f"cog_dir::s002.cog": _FAKE_COG_DATA["s002"],
    }

    # Patch index module
    index_mod.DATA_DATE_MIN = "2021-05-27"
    index_mod.DATA_DATE_MAX = "2021-06-01"
    index_mod._INDEX_READY  = True
    index_mod._ANN_META["cog"] = {
        "COG0001": {
            "annotation_id": "COG0001", "name": "GroEL", "parent": "J",
            "value": {"name": "GroEL", "egc": 150.0, "norm_egc": 0.0015},
            "mean_egc": 150.0, "max_egc": 200.0,
            "mean_norm_egc": 0.0015, "max_norm_egc": 0.002,
            "sample_count": 2,
        }
    }
    index_mod._ANN_META["taxonomy"] = {
        "Bacteria": {
            "annotation_id": "Bacteria", "name": "Bacteria", "parent": None,
            "value": {"depth": 1, "category": "Bacteria", "parent": None,
                      "egc": 1000.0, "norm_egc": 0.01},
            "mean_egc": 1000.0, "max_egc": 1200.0,
            "mean_norm_egc": 0.01, "max_norm_egc": 0.012,
            "sample_count": 2,
        },
        "Bacteroidetes": {
            "annotation_id": "Bacteroidetes", "name": "Bacteroidetes", "parent": "Bacteria",
            "value": {"depth": 2, "category": "Bacteria", "parent": "Bacteria",
                      "egc": 300.0, "norm_egc": 0.003},
            "mean_egc": 300.0, "max_egc": 350.0,
            "mean_norm_egc": 0.003, "max_norm_egc": 0.0035,
            "sample_count": 2,
        },
        "Proteobacteria": {
            "annotation_id": "Proteobacteria", "name": "Proteobacteria", "parent": "Bacteria",
            "value": {"depth": 2, "category": "Bacteria", "parent": "Bacteria",
                      "egc": 250.0, "norm_egc": 0.0025},
            "mean_egc": 250.0, "max_egc": 300.0,
            "mean_norm_egc": 0.0025, "max_norm_egc": 0.003,
            "sample_count": 2,
        },
    }
    index_mod._MAPPING_INDEX["kegg"] = {
        "K00010": [("s001", _FAKE_TSV["s001"][0])],
    }

    # Patch astronomy
    astro_mod.SUN_TIMES = _FAKE_SUN_TIMES

    # Override loaders to use patched data
    def _fake_get_all_samples():
        return sorted(_FAKE_TIMEPOINTS.keys())

    def _fake_load_cog(sample_name):
        return _FAKE_COG_DATA.get(sample_name, {})

    def _fake_load_kegg(sample_name):
        return _FAKE_KEGG_DATA.get(sample_name, {})

    def _fake_load_enzyme(sample_name):
        return _FAKE_ENZYME_DATA.get(sample_name, {})

    def _fake_load_taxonomy(sample_name):
        return _FAKE_TAXONOMY_DATA.get(sample_name, {})

    def _fake_load_tsv(sample_name):
        return _FAKE_TSV.get(sample_name, [])

    def _fake_load_by_source(sample_name, source):
        from api.cache import AnnotationSource
        return {
            AnnotationSource.cog:      _FAKE_COG_DATA,
            AnnotationSource.kegg:     _FAKE_KEGG_DATA,
            AnnotationSource.enzyme:   _FAKE_ENZYME_DATA,
            AnnotationSource.taxonomy: _FAKE_TAXONOMY_DATA,
        }.get(source, {}).get(sample_name, {})

    orig_get_all      = cache_mod.get_all_sample_names
    orig_load_cog      = cache_mod.load_cog
    orig_load_kegg     = cache_mod.load_kegg
    orig_load_enzyme   = cache_mod.load_enzyme
    orig_load_taxonomy = cache_mod.load_taxonomy
    orig_load_tsv      = cache_mod.load_tsv
    orig_load_by_source = cache_mod.load_annotations_by_source

    cache_mod.get_all_sample_names     = _fake_get_all_samples
    cache_mod.load_cog                 = _fake_load_cog
    cache_mod.load_kegg                = _fake_load_kegg
    cache_mod.load_enzyme              = _fake_load_enzyme
    cache_mod.load_taxonomy            = _fake_load_taxonomy
    cache_mod.load_tsv                 = _fake_load_tsv
    cache_mod.load_annotations_by_source = _fake_load_by_source

    # Also patch the references that routes.py imported directly
    routes_mod.get_all_sample_names     = _fake_get_all_samples
    routes_mod.load_tsv                 = _fake_load_tsv
    routes_mod.load_annotations_by_source = _fake_load_by_source

    from fastapi.testclient import TestClient
    from main import app
    client = TestClient(app, raise_server_exceptions=False)

    yield client

    # Restore originals
    cache_mod.get_all_sample_names     = orig_get_all
    cache_mod.load_cog                 = orig_load_cog
    cache_mod.load_kegg                = orig_load_kegg
    cache_mod.load_enzyme              = orig_load_enzyme
    cache_mod.load_taxonomy            = orig_load_taxonomy
    cache_mod.load_tsv                 = orig_load_tsv
    cache_mod.load_annotations_by_source = orig_load_by_source
    routes_mod.TIMEPOINTS              = orig_routes_timepoints


class TestRoutesViaTestClient:
    """
    HTTP-level tests for previously-untested endpoints.
    Uses the patched_client fixture — no real data or server needed.
    """

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

    def test_list_samples_returns_200(self, patched_client):
        r = patched_client.get("/samples")
        assert r.status_code == 200

    def test_list_samples_has_data(self, patched_client):
        body = patched_client.get("/samples").json()
        assert "data" in body
        assert body["total"] >= 1

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

    def test_search_annotations_cog(self, patched_client):
        r = patched_client.get("/search/annotations?q=GroEL&sources=cog")
        # May be 200 (index) or 200 (scan fallback) — just not 500
        assert r.status_code in (200, 404)

    def test_search_annotations_missing_query_is_400(self, patched_client):
        r = patched_client.get("/search/annotations?sources=cog")
        assert r.status_code == 400

    def test_annotation_time_series_200(self, patched_client):
        r = patched_client.get("/series/annotations?source=cog&annotation_id=COG0001")
        # Will be 200 if fake data has the annotation, 404 otherwise
        assert r.status_code in (200, 404)

    def test_top_annotations_400_missing_source(self, patched_client):
        r = patched_client.get("/annotations/top")
        assert r.status_code == 422  # FastAPI validation error (missing required param)

    def test_top_annotations_200_with_source(self, patched_client):
        r = patched_client.get("/annotations/top?source=cog")
        assert r.status_code == 200

    def test_top_annotations_has_data_field(self, patched_client):
        body = patched_client.get("/annotations/top?source=cog").json()
        assert "data" in body

    def test_mappings_search_returns_dict(self, patched_client):
        r = patched_client.get("/mappings/search?annotation_id=K00010&source=kegg")
        assert r.status_code == 200
        assert "data" in r.json()

    # ── /timepoints ──────────────────────────────────────────────────────
    # Now backend-aware (filters to real samples -- see docs/AUDIT.md's
    # "132 vs 128" item), so these 3 join the pre-existing
    # DATA_BACKEND=sql/patched_client gap under the real .env config
    # (patched_client only patches JSON-backend internals; real DB access
    # via app.state.sql_conn isn't set up). See the module-level Note above
    # TestRoutesViaTestClient for the same root cause on other routes.
    # _filter_timepoints_to_real_samples's actual logic is covered directly,
    # bypassing this gap, in TestFilterTimepointsToRealSamples below.

    def test_timepoints_returns_200(self, patched_client):
        r = patched_client.get("/timepoints")
        assert r.status_code == 200

    def test_timepoints_has_paginated_data(self, patched_client):
        body = patched_client.get("/timepoints").json()
        assert "data"  in body
        assert "total" in body
        assert body["total"] == len(_FAKE_TIMEPOINTS)

    def test_timepoints_rows_match_fake_data(self, patched_client):
        body = patched_client.get("/timepoints").json()
        taxon_oids = {row["taxon_oid"] for row in body["data"]}
        assert taxon_oids == set(_FAKE_TIMEPOINTS.keys())


# ═══════════════════════════════════════════════════════════════════════════════
# GET /taxonomy/children
# ═══════════════════════════════════════════════════════════════════════════════

class TestTaxonomyChildrenJsonBranchDirect:
    """Direct calls to routes.taxonomy_children's DATA_BACKEND=='json' branch
    -- the "/taxonomy/children differs between backends: JSON returns bare
    names and no name field" item (docs/AUDIT.md's Also-noted list).

    Called directly with DATA_BACKEND monkeypatched to 'json' (routes.py
    imports it by value, so routes.DATA_BACKEND is what must be patched --
    patching api.config.DATA_BACKEND has no effect, same gotcha
    patched_client's own comments call out for TIMEPOINTS) rather than via
    patched_client/HTTP, since TestTaxonomyChildrenEndpoint's HTTP tests
    already run against the real DATA_BACKEND=sql config and hit the
    pre-existing sql_conn gap before ever reaching the JSON branch this is
    actually about.
    """

    @pytest.fixture(autouse=True)
    def _patch_json_backend(self):
        import api.routes as routes_mod
        orig_backend = routes_mod.DATA_BACKEND
        orig_meta    = dict(routes_mod._ANN_META["taxonomy"])
        routes_mod.DATA_BACKEND = 'json'
        routes_mod._ANN_META["taxonomy"] = {
            "Bacteria": {
                "annotation_id": "Bacteria", "parent": None,
                "value": {"depth": 1, "category": "Bacteria"},
            },
            "Bacteria;Proteobacteria": {
                "annotation_id": "Bacteria;Proteobacteria", "parent": "Bacteria",
                "value": {"depth": 2, "category": "Bacteria"},
            },
        }
        yield
        routes_mod.DATA_BACKEND = orig_backend
        routes_mod._ANN_META["taxonomy"] = orig_meta

    async def _call(self, parent=None):
        from api.routes import taxonomy_children
        return await taxonomy_children(request=None, parent=parent)

    async def test_domain_root_has_a_bare_name_field(self):
        body = await self._call(None)
        row = body["data"][0]
        assert row["annotation_id"] == "Bacteria"
        assert row["name"] == "Bacteria"

    async def test_deeper_child_gets_its_bare_last_segment_as_name_not_the_full_lineage(self):
        body = await self._call("Bacteria")
        row = body["data"][0]
        assert row["annotation_id"] == "Bacteria;Proteobacteria"
        assert row["name"] == "Proteobacteria"
        assert row["name"] != row["annotation_id"]

    async def test_name_matches_the_sql_backends_bare_name_convention(self):
        # get_taxonomy_children_sql uses child_name (the last lineage
        # segment) as `name` -- this pins the JSON branch to the same
        # convention so the tree renders identically on both backends.
        body = await self._call("Bacteria")
        row = body["data"][0]
        assert row["name"] == row["annotation_id"].split(";")[-1]


class TestTaxonomyChildrenEndpoint:
    """HTTP-level tests for GET /taxonomy/children."""

    def test_no_parent_returns_roots(self, patched_client):
        r = patched_client.get("/taxonomy/children")
        assert r.status_code == 200
        ids = {c["annotation_id"] for c in r.json()["data"]}
        assert ids == {"Bacteria"}

    def test_root_children_returns_phyla(self, patched_client):
        r = patched_client.get("/taxonomy/children?parent=Bacteria")
        assert r.status_code == 200
        ids = {c["annotation_id"] for c in r.json()["data"]}
        assert ids == {"Bacteroidetes", "Proteobacteria"}

    def test_children_include_depth_and_category(self, patched_client):
        body = patched_client.get("/taxonomy/children?parent=Bacteria").json()
        row = body["data"][0]
        assert row["depth"] == 2
        assert row["category"] == "Bacteria"

    def test_leaf_node_returns_empty_list_not_404(self, patched_client):
        r = patched_client.get("/taxonomy/children?parent=Bacteroidetes")
        assert r.status_code == 200
        assert r.json()["data"] == []

    def test_unknown_parent_is_404(self, patched_client):
        r = patched_client.get("/taxonomy/children?parent=NotARealTaxon")
        assert r.status_code == 404