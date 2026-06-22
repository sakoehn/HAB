"""
test_jgi_file_parsing.py
========================
Phase 1 — Ground-truth file validation.

These tests verify that the JGI EGC files themselves are readable, well-formed,
and internally consistent BEFORE any comparison with backend data.
If these fail, nothing else is trustworthy.

Run alone:
    python -m pytest tests/test_jgi_file_parsing.py -v
"""

import pytest
from pathlib import Path

from conftest import (
    COG_EGC_FILE_1,
    COG_EGC_FILE_2,
    KEGG_EGC_FILE_1,
    KEGG_EGC_FILE_2,
    _parse_egc_file,
    _merge_egc_files,
    DATA_ROOT,
)


# ── Existence checks ──────────────────────────────────────────────────────────

class TestFilesExist:
    """All four JGI EGC files must be present at the configured paths."""

    def test_cog_file_1_exists(self):
        assert COG_EGC_FILE_1.exists(), (
            f"Missing: {COG_EGC_FILE_1}\nCheck HAB_DATA_ROOT={DATA_ROOT}"
        )

    def test_cog_file_2_exists(self):
        assert COG_EGC_FILE_2.exists(), (
            f"Missing: {COG_EGC_FILE_2}\nCheck HAB_DATA_ROOT={DATA_ROOT}"
        )

    def test_kegg_file_1_exists(self):
        assert KEGG_EGC_FILE_1.exists(), (
            f"Missing: {KEGG_EGC_FILE_1}\nCheck HAB_DATA_ROOT={DATA_ROOT}"
        )

    def test_kegg_file_2_exists(self):
        assert KEGG_EGC_FILE_2.exists(), (
            f"Missing: {KEGG_EGC_FILE_2}\nCheck HAB_DATA_ROOT={DATA_ROOT}"
        )

    def test_all_four_files_are_non_empty(self):
        for path in [COG_EGC_FILE_1, COG_EGC_FILE_2, KEGG_EGC_FILE_1, KEGG_EGC_FILE_2]:
            if path.exists():
                assert path.stat().st_size > 0, f"File is empty: {path}"


# ── COG file parsing ──────────────────────────────────────────────────────────

class TestCOGFileParsing:
    """Verify each COG file parses into a valid, populated table."""

    def test_cog_file_1_parses_without_error(self):
        table = _parse_egc_file(COG_EGC_FILE_1)
        assert isinstance(table, dict)

    def test_cog_file_2_parses_without_error(self):
        table = _parse_egc_file(COG_EGC_FILE_2)
        assert isinstance(table, dict)

    def test_cog_file_1_has_annotation_rows(self):
        table = _parse_egc_file(COG_EGC_FILE_1)
        assert len(table) > 0, "COG file 1 parsed to an empty table"

    def test_cog_file_2_has_annotation_rows(self):
        table = _parse_egc_file(COG_EGC_FILE_2)
        assert len(table) > 0, "COG file 2 parsed to an empty table"

    def test_cog_annotation_ids_start_with_cog(self):
        table = _parse_egc_file(COG_EGC_FILE_1)
        bad = [k for k in table if not k.upper().startswith("COG")]
        assert not bad, f"Unexpected non-COG IDs in COG file: {bad[:5]}"

    def test_cog_file_1_has_expected_sample_count(self):
        """File 1 covers a subset of the 128 samples (actual split may be uneven)."""
        table = _parse_egc_file(COG_EGC_FILE_1)
        first_row = next(iter(table.values()))
        assert 1 <= len(first_row) <= 128, (
            f"COG file 1 has {len(first_row)} samples — expected 1–128"
        )

    def test_cog_file_2_has_expected_sample_count(self):
        """File 2 covers the remaining samples (actual split may be uneven)."""
        table = _parse_egc_file(COG_EGC_FILE_2)
        first_row = next(iter(table.values()))
        assert 1 <= len(first_row) <= 128, (
            f"COG file 2 has {len(first_row)} samples — expected 1–128"
        )

    def test_cog_egc_values_are_non_negative(self):
        table = _parse_egc_file(COG_EGC_FILE_1)
        for ann_id, samples in table.items():
            for sample_id, val in samples.items():
                assert val >= 0, (
                    f"Negative EGC in COG file 1: {ann_id} / {sample_id} = {val}"
                )

    def test_cog_file_1_sample_ids_are_numeric_strings(self):
        """JGI sample IDs extracted from header should be all digits."""
        table = _parse_egc_file(COG_EGC_FILE_1)
        first_row = next(iter(table.values()))
        for sid in first_row:
            assert sid.isdigit(), (
                f"Non-numeric sample ID parsed from COG file 1 header: '{sid}'"
            )

    def test_cog_known_annotation_present_in_file_1(self):
        """COG0001 appears in row 2 of the screenshot — must be present."""
        table = _parse_egc_file(COG_EGC_FILE_1)
        assert "COG0001" in table, "COG0001 not found in COG file 1"

    def test_cog0001_first_sample_egc_matches_screenshot(self):
        """
        Screenshot row 2 shows COG0001 / 3300060410 = 5771.
        This is the single most important spot-check.
        """
        table = _parse_egc_file(COG_EGC_FILE_1)
        assert "COG0001" in table
        samples = table["COG0001"]
        assert "3300060410" in samples, (
            "Sample 3300060410 not found in COG0001 row"
        )
        assert abs(samples["3300060410"] - 5771.0) < 0.5, (
            f"COG0001 / 3300060410 EGC mismatch: got {samples['3300060410']}, expected 5771"
        )


# ── KEGG file parsing ─────────────────────────────────────────────────────────

class TestKEGGFileParsing:
    """Verify each KEGG file parses into a valid, populated table."""

    def test_kegg_file_1_parses_without_error(self):
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        assert isinstance(table, dict)

    def test_kegg_file_2_parses_without_error(self):
        table = _parse_egc_file(KEGG_EGC_FILE_2)
        assert isinstance(table, dict)

    def test_kegg_file_1_has_annotation_rows(self):
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        assert len(table) > 0, "KEGG file 1 parsed to an empty table"

    def test_kegg_file_2_has_annotation_rows(self):
        table = _parse_egc_file(KEGG_EGC_FILE_2)
        assert len(table) > 0, "KEGG file 2 parsed to an empty table"

    def test_kegg_annotation_ids_use_ko_prefix(self):
        """
        JGI KEGG files use the 'KO:K#####' format, not bare 'K#####'.
        This documents the actual ID format so downstream code can match it.
        """
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        sample_id = next(iter(table))
        assert sample_id.startswith("KO:K"), (
            f"Expected KEGG IDs to start with 'KO:K', got: '{sample_id}'\n"
            "Update your backend lookup keys if they use bare 'K#####' format."
        )

    def test_kegg_annotation_ids_start_with_k(self):
        """All annotation IDs contain a K-number (with or without KO: prefix)."""
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        bad = [k for k in table if "K" not in k.upper()]
        assert not bad, f"Unexpected non-KEGG IDs in KEGG file: {bad[:5]}"

    def test_kegg_file_1_has_expected_sample_count(self):
        """File 1 covers a subset of the 128 samples (actual split may be uneven)."""
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        first_row = next(iter(table.values()))
        assert 1 <= len(first_row) <= 128, (
            f"KEGG file 1 has {len(first_row)} samples — expected 1–128"
        )

    def test_kegg_file_2_has_expected_sample_count(self):
        """File 2 covers the remaining samples (actual split may be uneven)."""
        table = _parse_egc_file(KEGG_EGC_FILE_2)
        first_row = next(iter(table.values()))
        assert 1 <= len(first_row) <= 128, (
            f"KEGG file 2 has {len(first_row)} samples — expected 1–128"
        )

    def test_kegg_egc_values_are_non_negative(self):
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        for ann_id, samples in table.items():
            for sample_id, val in samples.items():
                assert val >= 0, (
                    f"Negative EGC in KEGG file 1: {ann_id} / {sample_id} = {val}"
                )

    def test_kegg_file_1_sample_ids_are_numeric_strings(self):
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        first_row = next(iter(table.values()))
        for sid in first_row:
            assert sid.isdigit(), (
                f"Non-numeric sample ID parsed from KEGG file 1 header: '{sid}'"
            )

    def test_kegg_known_annotation_present_in_file_1(self):
        """KO:K00001 appears in row 2 of the KEGG screenshot — must be present."""
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        assert "KO:K00001" in table, (
            f"KO:K00001 not found in KEGG file 1. "
            f"First 3 keys: {list(table)[:3]}"
        )

    def test_k00001_first_sample_egc_matches_screenshot(self):
        """
        Screenshot row 2 shows K00001 / 3300060410 = 219.
        JGI stores this as 'KO:K00001'.
        """
        table = _parse_egc_file(KEGG_EGC_FILE_1)
        assert "KO:K00001" in table, (
            f"KO:K00001 not found. First 3 keys: {list(table)[:3]}"
        )
        samples = table["KO:K00001"]
        assert "3300060410" in samples, (
            "Sample 3300060410 not found in KO:K00001 row"
        )
        assert abs(samples["3300060410"] - 219.0) < 0.5, (
            f"KO:K00001 / 3300060410 EGC mismatch: got {samples['3300060410']}, expected 219"
        )


# ── Merge logic ───────────────────────────────────────────────────────────────

class TestMergeLogic:
    """Verify that merging the two split-files produces a correct combined table."""

    def test_cog_merge_produces_all_128_samples(self):
        merged = _merge_egc_files(COG_EGC_FILE_1, COG_EGC_FILE_2)
        first_row = next(iter(merged.values()))
        assert len(first_row) == 128, (
            f"Merged COG table has {len(first_row)} samples — expected 128"
        )

    def test_kegg_merge_produces_all_128_samples(self):
        merged = _merge_egc_files(KEGG_EGC_FILE_1, KEGG_EGC_FILE_2)
        first_row = next(iter(merged.values()))
        assert len(first_row) == 128, (
            f"Merged KEGG table has {len(first_row)} samples — expected 128"
        )

    def test_cog_split_files_have_no_overlapping_samples(self):
        """Samples in file 1 and file 2 must not overlap."""
        t1 = _parse_egc_file(COG_EGC_FILE_1)
        t2 = _parse_egc_file(COG_EGC_FILE_2)
        first_id = next(iter(t1))
        overlap = set(t1[first_id]) & set(t2.get(first_id, {}))
        assert not overlap, (
            f"COG split files share sample IDs (should be mutually exclusive): {overlap}"
        )

    def test_kegg_split_files_have_no_overlapping_samples(self):
        t1 = _parse_egc_file(KEGG_EGC_FILE_1)
        t2 = _parse_egc_file(KEGG_EGC_FILE_2)
        first_id = next(iter(t1))
        overlap = set(t1[first_id]) & set(t2.get(first_id, {}))
        assert not overlap, (
            f"KEGG split files share sample IDs (should be mutually exclusive): {overlap}"
        )

    def test_cog_merge_annotation_count_matches_individual_files(self):
        """Merging must not lose or duplicate annotation rows."""
        t1 = _parse_egc_file(COG_EGC_FILE_1)
        t2 = _parse_egc_file(COG_EGC_FILE_2)
        merged = _merge_egc_files(COG_EGC_FILE_1, COG_EGC_FILE_2)
        expected_count = len(set(t1) | set(t2))
        assert len(merged) == expected_count, (
            f"Merged COG annotation count {len(merged)} ≠ expected {expected_count}"
        )

    def test_kegg_merge_annotation_count_matches_individual_files(self):
        t1 = _parse_egc_file(KEGG_EGC_FILE_1)
        t2 = _parse_egc_file(KEGG_EGC_FILE_2)
        merged = _merge_egc_files(KEGG_EGC_FILE_1, KEGG_EGC_FILE_2)
        expected_count = len(set(t1) | set(t2))
        assert len(merged) == expected_count, (
            f"Merged KEGG annotation count {len(merged)} ≠ expected {expected_count}"
        )

    def test_cog_merge_preserves_file1_values(self):
        """Values from file 1 must survive the merge unchanged."""
        t1 = _parse_egc_file(COG_EGC_FILE_1)
        merged = _merge_egc_files(COG_EGC_FILE_1, COG_EGC_FILE_2)
        ann_id = "COG0001"
        if ann_id in t1:
            for sample_id, val in t1[ann_id].items():
                assert merged[ann_id][sample_id] == val, (
                    f"Merge corrupted COG0001/{sample_id}: "
                    f"expected {val}, got {merged[ann_id][sample_id]}"
                )

    def test_cog_merge_preserves_file2_values(self):
        """Values from file 2 must survive the merge unchanged."""
        t2 = _parse_egc_file(COG_EGC_FILE_2)
        merged = _merge_egc_files(COG_EGC_FILE_1, COG_EGC_FILE_2)
        ann_id = next(iter(t2))
        for sample_id, val in t2[ann_id].items():
            assert merged[ann_id][sample_id] == val, (
                f"Merge corrupted {ann_id}/{sample_id}: "
                f"expected {val}, got {merged[ann_id][sample_id]}"
            )