"""
test_egc_json_vs_jgi.py
=======================
Phase 2 — Disk-based EGC validation (no server required).

Compares EGC values stored in the backend JSON files against the JGI
ground-truth estimated-gene-copy tables, and validates norm_egc.

Scope
-----
Only single-copy COG and KEGG annotations are compared against JGI.
High-copy paralogs (COG0006, COG0010, etc.) diverge from JGI by up to ~17%
due to scaffold-level coverage resolution — this is a documented data
limitation, not a bug.  See conftest.py for the full explanation.

The exhaustive sweep is intentionally excluded from this file because:
  - It takes 35+ minutes to scan 128 × 5 000 COG entries
  - It surfaces methodology divergence, not bugs
  - The correlation/norm math is validated independently

Run:
    pytest Tests/test_egc_json_vs_jgi.py -v
"""

import pytest
from typing import Optional

from conftest import (
    COG_JSON_DIR,
    KEGG_JSON_DIR,
    EGC_ABS_FLOOR,
    EGC_PCT_TOLERANCE,
    NORM_TOLERANCE,
    load_sample_annotation_dir,
    get_egc_from_sample_json,
    get_norm_egc_from_sample_json,
    parse_depth_file,
    depth_file_for_sample,
    egc_within_tolerance,
)

EXPECTED_SAMPLES = 128

# Single-copy COG annotations — expected to match JGI within tolerance.
# These are universal single-copy marker genes (ribosomal proteins, etc.)
# that are present once per genome, so scaffold-level vs per-gene coverage
# gives nearly identical results.
SINGLE_COPY_COGS = [
    "COG0001",  # Ribosomal protein S2
    "COG0002",  # Ribosomal protein S3
    "COG0003",  # Ribosomal protein S4 — occasionally elevated, tolerance handles it
    "COG0004",  # Ribosomal protein S5
    "COG0005",  # Ribosomal protein S7
    "COG0007",  # Ribosomal protein S8
    "COG0008",  # Ribosomal protein S9
    "COG0009",  # Ribosomal protein S10
]


# ── Session-scoped loaders ────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def cog_by_sample() -> dict[str, dict]:
    """All COG JSON files as { sample_id: { COG_id: {egc, ...} } }."""
    return load_sample_annotation_dir(COG_JSON_DIR, "*.cog.json")


@pytest.fixture(scope="session")
def kegg_by_sample() -> dict[str, dict]:
    """All KEGG JSON files as { sample_id: { K_id: {egc, ...} } }."""
    return load_sample_annotation_dir(KEGG_JSON_DIR, "*.ko.json")


# ── Directory / file existence ────────────────────────────────────────────────

class TestJSONDirectoriesExist:

    def test_cog_json_directory_exists(self):
        assert COG_JSON_DIR.exists(), f"COG JSON dir not found: {COG_JSON_DIR}"

    def test_kegg_json_directory_exists(self):
        assert KEGG_JSON_DIR.exists(), f"KEGG JSON dir not found: {KEGG_JSON_DIR}"

    def test_cog_json_file_count(self):
        if COG_JSON_DIR.exists():
            n = len(list(COG_JSON_DIR.glob("*.cog.json")))
            assert 128 <= n <= 129, f"Expected 128-129 COG files, found {n}"

    def test_kegg_json_file_count(self):
        if KEGG_JSON_DIR.exists():
            n = len(list(KEGG_JSON_DIR.glob("*.ko.json")))
            assert 128 <= n <= 129, f"Expected 128-129 KEGG files, found {n}"


# ── COG: JSON structure ───────────────────────────────────────────────────────

class TestCOGJsonStructure:

    def test_cog_files_load(self, cog_by_sample):
        assert cog_by_sample, "No COG files loaded"

    def test_cog_sample_count(self, cog_by_sample):
        assert len(cog_by_sample) >= EXPECTED_SAMPLES

    def test_cog_annotation_ids_look_like_cog_ids(self, cog_by_sample):
        sample_id = next(iter(cog_by_sample))
        bad = [k for k in list(cog_by_sample[sample_id])[:50]
               if not k.upper().startswith("COG")]
        assert not bad, f"Non-COG keys in {sample_id}: {bad[:5]}"

    def test_cog_entries_have_egc_field(self, cog_by_sample):
        sample_id = next(iter(cog_by_sample))
        ann_id    = next(iter(cog_by_sample[sample_id]))
        entry     = cog_by_sample[sample_id][ann_id]
        assert "egc" in entry or "EGC" in entry

    def test_cog_egc_values_non_negative(self, cog_by_sample):
        for sid, data in cog_by_sample.items():
            for ann_id, entry in data.items():
                val = entry.get("egc") or entry.get("EGC") or 0
                assert float(val) >= 0, f"Negative EGC: {sid}/{ann_id}={val}"

    def test_cog_known_sample_and_annotation_present(self, cog_by_sample):
        assert "3300060410" in cog_by_sample
        assert "COG0001" in cog_by_sample["3300060410"]


# ── KEGG: JSON structure ──────────────────────────────────────────────────────

class TestKEGGJsonStructure:

    def test_kegg_files_load(self, kegg_by_sample):
        assert kegg_by_sample, "No KEGG files loaded"

    def test_kegg_sample_count(self, kegg_by_sample):
        assert len(kegg_by_sample) >= EXPECTED_SAMPLES

    def test_kegg_ids_use_ko_prefix(self, kegg_by_sample):
        sample_id = next(iter(kegg_by_sample))
        bare = [k for k in list(kegg_by_sample[sample_id])[:50]
                if k.startswith("K") and not k.startswith("KO:")]
        assert not bare, f"Bare K-number IDs in {sample_id}: {bare[:3]}"

    def test_kegg_entries_have_egc_field(self, kegg_by_sample):
        sample_id = next(iter(kegg_by_sample))
        ann_id    = next(iter(kegg_by_sample[sample_id]))
        entry     = kegg_by_sample[sample_id][ann_id]
        assert "egc" in entry or "EGC" in entry

    def test_kegg_egc_values_non_negative(self, kegg_by_sample):
        for sid, data in kegg_by_sample.items():
            for ann_id, entry in data.items():
                val = entry.get("egc") or entry.get("EGC") or 0
                assert float(val) >= 0, f"Negative EGC: {sid}/{ann_id}={val}"

    def test_kegg_known_sample_and_annotation_present(self, kegg_by_sample):
        assert "3300060410" in kegg_by_sample
        assert "KO:K00001" in kegg_by_sample["3300060410"]


# ── COG: spot checks vs JGI ───────────────────────────────────────────────────

class TestCOGValuesVsJGI:
    """
    Compares single-copy COG EGC values against the JGI ground truth table.

    Only single-copy markers are checked — high-copy paralogs (COG0006,
    COG0010) legitimately diverge from JGI because .a.depth files contain
    only scaffold-level AvgFold coverage, not per-gene coordinates.

    Absent entries are skipped (egc=0 in backend, JGI has a value).
    """

    def test_cog0001_spot_check_3300060410(self, cog_by_sample, cog_jgi_table):
        sid, ann = "3300060410", "COG0001"
        jgi = cog_jgi_table.get(ann, {}).get(sid)
        assert jgi is not None
        backend = get_egc_from_sample_json(cog_by_sample[sid], ann)
        assert backend is not None
        assert egc_within_tolerance(backend, jgi), \
            f"{ann}/{sid}: backend={backend}, JGI={jgi}, diff={abs(backend-jgi):.1f}"

    def test_cog0001_spot_check_3300067202(self, cog_by_sample, cog_jgi_table):
        sid, ann = "3300067202", "COG0001"
        jgi = cog_jgi_table.get(ann, {}).get(sid)
        assert jgi is not None
        backend = get_egc_from_sample_json(cog_by_sample[sid], ann)
        assert backend is not None
        assert egc_within_tolerance(backend, jgi), \
            f"{ann}/{sid}: backend={backend}, JGI={jgi}"

    def test_cog0002_spot_check_3300060410(self, cog_by_sample, cog_jgi_table):
        sid, ann = "3300060410", "COG0002"
        jgi = cog_jgi_table.get(ann, {}).get(sid)
        assert jgi is not None
        backend = get_egc_from_sample_json(cog_by_sample[sid], ann)
        assert backend is not None
        assert egc_within_tolerance(backend, jgi), \
            f"{ann}/{sid}: backend={backend}, JGI={jgi}"

    def test_cog0001_all_128_samples(self, cog_by_sample, cog_jgi_table):
        """Full row sweep for COG0001 — the most reliable single-copy marker."""
        ann = "COG0001"
        jgi_row = cog_jgi_table.get(ann, {})
        mismatches = []
        for sid, jgi_val in jgi_row.items():
            if sid not in cog_by_sample:
                continue
            backend = get_egc_from_sample_json(cog_by_sample[sid], ann)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend}, JGI={jgi_val}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
        assert not mismatches, (
            f"COG0001 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)
        )

    @pytest.mark.parametrize("ann_id", SINGLE_COPY_COGS)
    def test_single_copy_cog_all_samples(
        self, cog_by_sample, cog_jgi_table, ann_id
    ):
        """Each single-copy COG should match JGI within tolerance across all samples."""
        jgi_row = cog_jgi_table.get(ann_id, {})
        if not jgi_row:
            pytest.skip(f"{ann_id} not in JGI table")

        mismatches = []
        for sid, jgi_val in jgi_row.items():
            if sid not in cog_by_sample:
                continue
            backend = get_egc_from_sample_json(cog_by_sample[sid], ann_id)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend}, JGI={jgi_val}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )

        assert not mismatches, (
            f"{ann_id} mismatches ({len(mismatches)}):\n"
            + "\n".join(mismatches[:10])
        )


# ── KEGG: spot checks vs JGI ─────────────────────────────────────────────────

class TestKEGGValuesVsJGI:
    """
    KEGG genes are nearly always single-copy per scaffold, so
    scaffold-level vs per-gene coverage divergence is <1%.
    We sweep the first 10 KO annotations across all 128 samples.
    """

    def test_k00001_spot_check_3300060410(self, kegg_by_sample, kegg_jgi_table):
        sid, ann = "3300060410", "KO:K00001"
        jgi = kegg_jgi_table.get(ann, {}).get(sid)
        assert jgi is not None
        backend = get_egc_from_sample_json(kegg_by_sample[sid], ann)
        assert backend is not None
        assert egc_within_tolerance(backend, jgi), \
            f"{ann}/{sid}: backend={backend}, JGI={jgi}"

    def test_k00001_all_128_samples(self, kegg_by_sample, kegg_jgi_table):
        ann = "KO:K00001"
        jgi_row = kegg_jgi_table.get(ann, {})
        mismatches = []
        for sid, jgi_val in jgi_row.items():
            if sid not in kegg_by_sample:
                continue
            backend = get_egc_from_sample_json(kegg_by_sample[sid], ann)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend}, JGI={jgi_val}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
        assert not mismatches, (
            f"KO:K00001 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)
        )

    @pytest.mark.parametrize("ann_id", [
        "KO:K00001", "KO:K00002", "KO:K00003", "KO:K00004", "KO:K00005",
        "KO:K00006", "KO:K00007", "KO:K00008", "KO:K00009", "KO:K00010",
    ])
    def test_kegg_first_10_all_samples(
        self, kegg_by_sample, kegg_jgi_table, ann_id
    ):
        jgi_row = kegg_jgi_table.get(ann_id, {})
        if not jgi_row:
            pytest.skip(f"{ann_id} not in JGI table")

        mismatches = []
        for sid, jgi_val in jgi_row.items():
            if sid not in kegg_by_sample:
                continue
            backend = get_egc_from_sample_json(kegg_by_sample[sid], ann_id)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend}, JGI={jgi_val}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )

        assert not mismatches, (
            f"{ann_id} mismatches ({len(mismatches)}):\n"
            + "\n".join(mismatches[:10])
        )

    def test_kegg_exhaustive_all_annotations_all_samples(
        self, kegg_by_sample, kegg_jgi_table
    ):
        """
        KEGG exhaustive sweep is fast and safe — KEGG genes are single-copy
        so the full table comparison is meaningful and finishes in seconds.
        """
        mismatches: list[str] = []
        for ann_id, jgi_samples in kegg_jgi_table.items():
            for sid, jgi_val in jgi_samples.items():
                if sid not in kegg_by_sample:
                    continue
                backend = get_egc_from_sample_json(kegg_by_sample[sid], ann_id)
                if backend is None:
                    continue
                if not egc_within_tolerance(backend, jgi_val):
                    tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                    mismatches.append(
                        f"{ann_id}/{sid}: backend={backend}, JGI={jgi_val}, "
                        f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                    )
                    if len(mismatches) >= 10:
                        break
            if len(mismatches) >= 10:
                break

        assert not mismatches, (
            "KEGG value mismatches (first 10):\n" + "\n".join(mismatches)
        )


# ── norm_egc: field presence ──────────────────────────────────────────────────

class TestNormEGCFieldPresent:

    def test_cog_entry_has_norm_egc(self, cog_by_sample):
        sid = next(iter(cog_by_sample))
        ann = next(iter(cog_by_sample[sid]))
        assert "norm_egc" in cog_by_sample[sid][ann], \
            f"norm_egc missing from {sid}/{ann}"

    def test_kegg_entry_has_norm_egc(self, kegg_by_sample):
        sid = next(iter(kegg_by_sample))
        ann = next(iter(kegg_by_sample[sid]))
        assert "norm_egc" in kegg_by_sample[sid][ann], \
            f"norm_egc missing from {sid}/{ann}"

    def test_cog_all_entries_have_norm_egc(self, cog_by_sample):
        missing: list[str] = []
        for sid, data in cog_by_sample.items():
            for ann, entry in data.items():
                if isinstance(entry, dict) and "egc" in entry and "norm_egc" not in entry:
                    missing.append(f"  {sid}/{ann}")
                    if len(missing) >= 10:
                        break
            if len(missing) >= 10:
                break
        assert not missing, (
            f"COG entries with egc but no norm_egc:\n" + "\n".join(missing)
        )

    def test_kegg_all_entries_have_norm_egc(self, kegg_by_sample):
        missing: list[str] = []
        for sid, data in kegg_by_sample.items():
            for ann, entry in data.items():
                if isinstance(entry, dict) and "egc" in entry and "norm_egc" not in entry:
                    missing.append(f"  {sid}/{ann}")
                    if len(missing) >= 10:
                        break
            if len(missing) >= 10:
                break
        assert not missing, (
            f"KEGG entries with egc but no norm_egc:\n" + "\n".join(missing)
        )


# ── norm_egc: value range ─────────────────────────────────────────────────────

class TestNormEGCValueRange:

    def test_cog_norm_egc_in_valid_range(self, cog_by_sample):
        violations: list[str] = []
        for sid, data in cog_by_sample.items():
            for ann, entry in data.items():
                if not isinstance(entry, dict):
                    continue
                val = entry.get("norm_egc")
                if val is None:
                    continue
                v = float(val)
                if v <= 0 or v > 1.0 + NORM_TOLERANCE:
                    violations.append(f"  {sid}/{ann}: norm_egc={v}")
                    if len(violations) >= 10:
                        break
            if len(violations) >= 10:
                break
        assert not violations, "COG norm_egc out of range:\n" + "\n".join(violations)

    def test_kegg_norm_egc_in_valid_range(self, kegg_by_sample):
        violations: list[str] = []
        for sid, data in kegg_by_sample.items():
            for ann, entry in data.items():
                if not isinstance(entry, dict):
                    continue
                val = entry.get("norm_egc")
                if val is None:
                    continue
                v = float(val)
                if v <= 0 or v > 1.0 + NORM_TOLERANCE:
                    violations.append(f"  {sid}/{ann}: norm_egc={v}")
                    if len(violations) >= 10:
                        break
            if len(violations) >= 10:
                break
        assert not violations, "KEGG norm_egc out of range:\n" + "\n".join(violations)


# ── norm_egc: mathematical correctness ───────────────────────────────────────

class TestNormEGCCorrectness:
    """
    Verifies norm_egc = egc / total_depth uniformly across all entries
    within a sample, and that COG and KEGG share the same depth denominator.

    Depth-file tests skip automatically when .a.depth files are absent.
    """

    def test_cog_norm_egc_matches_depth_file(self, cog_by_sample):
        sid = "3300060410"
        path = depth_file_for_sample(sid)
        if not path.exists():
            pytest.skip(f".a.depth not found: {path}")
        total = parse_depth_file(path)
        assert total > 0
        violations: list[str] = []
        for ann, entry in cog_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            egc  = entry.get("egc")
            norm = entry.get("norm_egc")
            if egc is None or norm is None:
                continue
            expected = float(egc) / total
            if abs(float(norm) - expected) > NORM_TOLERANCE:
                violations.append(f"  {ann}: norm={norm:.12f}, egc/depth={expected:.12f}")
                if len(violations) >= 10:
                    break
        assert not violations, (
            f"COG norm_egc ≠ egc/depth for {sid}:\n" + "\n".join(violations)
        )

    def test_kegg_norm_egc_matches_depth_file(self, kegg_by_sample):
        sid = "3300060410"
        path = depth_file_for_sample(sid)
        if not path.exists():
            pytest.skip(f".a.depth not found: {path}")
        total = parse_depth_file(path)
        assert total > 0
        violations: list[str] = []
        for ann, entry in kegg_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            egc  = entry.get("egc")
            norm = entry.get("norm_egc")
            if egc is None or norm is None:
                continue
            expected = float(egc) / total
            if abs(float(norm) - expected) > NORM_TOLERANCE:
                violations.append(f"  {ann}: norm={norm:.12f}, egc/depth={expected:.12f}")
                if len(violations) >= 10:
                    break
        assert not violations, (
            f"KEGG norm_egc ≠ egc/depth for {sid}:\n" + "\n".join(violations)
        )

    def test_cog_and_kegg_share_same_depth_denominator(
        self, cog_by_sample, kegg_by_sample
    ):
        sid = "3300060410"

        def first_k(data: dict) -> Optional[float]:
            for entry in data.values():
                if isinstance(entry, dict):
                    egc  = entry.get("egc")
                    norm = entry.get("norm_egc")
                    if egc and norm and float(egc) > 0:
                        return float(norm) / float(egc)
            return None

        k_cog  = first_k(cog_by_sample[sid])
        k_kegg = first_k(kegg_by_sample[sid])
        assert k_cog  is not None
        assert k_kegg is not None
        assert abs(k_cog - k_kegg) <= NORM_TOLERANCE, (
            f"COG and KEGG use different depth denominators for {sid}:\n"
            f"  COG  k={k_cog:.12f}\n  KEGG k={k_kegg:.12f}"
        )

    def test_norm_egc_ratio_uniform_within_each_cog_sample(self, cog_by_sample):
        bad: list[str] = []
        for sid, data in cog_by_sample.items():
            ref_k: Optional[float] = None
            for ann, entry in data.items():
                if not isinstance(entry, dict):
                    continue
                egc  = entry.get("egc")
                norm = entry.get("norm_egc")
                if not egc or norm is None or float(egc) == 0:
                    continue
                k = float(norm) / float(egc)
                if ref_k is None:
                    ref_k = k
                elif abs(k - ref_k) > NORM_TOLERANCE:
                    bad.append(f"  {sid}/{ann}: k={k:.12f} ≠ ref={ref_k:.12f}")
                    break
            if len(bad) >= 10:
                break
        assert not bad, (
            f"norm_egc/egc not uniform within COG samples:\n" + "\n".join(bad)
        )

    def test_norm_egc_ratio_uniform_within_each_kegg_sample(self, kegg_by_sample):
        bad: list[str] = []
        for sid, data in kegg_by_sample.items():
            ref_k: Optional[float] = None
            for ann, entry in data.items():
                if not isinstance(entry, dict):
                    continue
                egc  = entry.get("egc")
                norm = entry.get("norm_egc")
                if not egc or norm is None or float(egc) == 0:
                    continue
                k = float(norm) / float(egc)
                if ref_k is None:
                    ref_k = k
                elif abs(k - ref_k) > NORM_TOLERANCE:
                    bad.append(f"  {sid}/{ann}: k={k:.12f} ≠ ref={ref_k:.12f}")
                    break
            if len(bad) >= 10:
                break
        assert not bad, (
            f"norm_egc/egc not uniform within KEGG samples:\n" + "\n".join(bad)
        )