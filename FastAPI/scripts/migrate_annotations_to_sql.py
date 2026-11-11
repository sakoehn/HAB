"""
migrate_annotations_to_sql.py
==============================
Populates `annotation_series` + `scaffolds` (see create_sql_schema.py)
from the per-sample annotation JSONs --
DataStructures/{COG,Kegg,Enzyme,Taxonomy}/<sample>.<suffix>.json.

Generic across all four sources -- SOURCES below is the one place
per-source differences live. Verified against real data: 575,702
annotation_series rows / 49,499,800 scaffolds rows across all 128 COG
samples, matching an independent recount straight from the raw JSON
files.

No taxon_path_id column exists on annotation_series -- the taxonomy ->
taxon_paths link happens at query time later (depth picks which
taxon_paths rank column to match against annotation_id), so this script
never touches taxon_paths at all.

Real scale to plan around: ~6.35M annotation_series rows total across
all 4 sources, but ~624M scaffolds rows total. Build indexes (a later
step) AFTER this bulk load, not during.

Safe to re-run: each sample's existing rows for a given source are
deleted before being reinserted (see populate_annotations_for_sample),
so re-running is a clean replace, not a duplicate-accumulating append.

Usage (from FastAPI/):
    python scripts/migrate_annotations_to_sql.py
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import COG_DIR, ENZYME_DIR, KEGG_DIR, SQLITE_DB_PATH, TAXONOMY_DIR  # pylint: disable=wrong-import-position,import-error

# Per-source config: (directory, filename suffix). Suffixes confirmed
# against real files in DataStructures/ -- enzyme is ".enzyme.json", not
# the ".enz.json" originally guessed.
SOURCES = {
    "cog":      (COG_DIR, ".cog.json"),
    "kegg":     (KEGG_DIR, ".ko.json"),
    "enzyme":   (ENZYME_DIR, ".enzyme.json"),
    "taxonomy": (TAXONOMY_DIR, ".tax.json"),
}


def build_annotation_series_row(source: str, sample: str, annotation_id: str, entry: dict) -> dict:
    """Transform one (sample, annotation_id -> entry) pair from a source
    JSON into a flat dict matching annotation_series' columns.

    Args:
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        sample: Sample name this entry belongs to.
        annotation_id: The annotation's ID.
        entry: The parsed JSON entry, e.g.
            {"name": ..., "category": ..., "egc": ..., "norm_egc": ...,
             "scaffolds": {"scaffold_a": 3, "scaffold_b": 1}}.
            Taxonomy entries have no "name" key (annotation_id is used as
            the name instead) and a "parent" field already holding another
            row's own annotation_id (a lineage-prefix string); KEGG/Enzyme/
            COG instead have "parent_id"/"parent_name" -- parent_id is what
            gets kept here: it matches another
            row's annotation_id the same way taxonomy's "parent" always
            has, which both the correlation family-exclusion tree-walk
            (get_family_candidates) and the frontend's expandParentLabel()
            depend on. parent_name (the human-readable text) is NOT stored
            here -- display code re-derives it from parent_id per source.
            "depth" means taxonomic rank for taxonomy but a source-specific
            pathway/EC hierarchy depth for KEGG/Enzyme/COG.

    Returns:
        Dict with keys matching annotation_series' columns: source,
        sample, annotation_id, name, category, parent, depth, egc,
        norm_egc, scaffold_count, gene_count (scaffold_count/gene_count
        are derived from entry["scaffolds"], not read from a precomputed
        field).
    """
    scaffolds = entry.get("scaffolds") or {}
    return {
        "source": source,
        "sample": sample,
        "annotation_id": annotation_id,
        "name": entry.get("name", annotation_id),
        "category": entry.get("category"),
        "parent": entry.get("parent", entry.get("parent_id")),
        "depth": entry.get("depth"),
        "egc": entry.get("egc"),
        "norm_egc": entry.get("norm_egc"),
        "scaffold_count": len(scaffolds),
        "gene_count": sum(scaffolds.values()),
    }


def iter_sample_files(source_dir: str, suffix: str):
    """Yield (sample_name, full_path) for every matching file in
    source_dir, sorted by sample_name.

    Args:
        source_dir: Directory to scan.
        suffix: Filename suffix identifying this source's files, e.g.
            ".cog.json". Stripped off to derive sample_name (e.g.
            "3300060358.cog.json" -> "3300060358").

    Yields:
        (sample_name, full_path) tuples.
    """
    for filename in sorted(os.listdir(source_dir)):
        if filename.endswith(suffix):
            sample_name = filename[:-len(suffix)]
            full_path = os.path.join(source_dir, filename)
            yield sample_name, full_path


def check_samples_are_known(sample_files) -> None:
    """Stop if any file's sample name is not a sample in the timepoints CSV.

    Every matching file in the folder is loaded, so a stray file (a copy
    like "3300060358 (1).cog.json", a test file) would otherwise become an
    extra sample in every chart, mean and sample count.
    """
    from api.cache import TIMEPOINTS  # pylint: disable=import-outside-toplevel,import-error
    unknown = sorted(sample for sample, _ in sample_files if sample not in TIMEPOINTS)
    if unknown:
        sys.exit(
            f"{len(unknown)} file(s) are not samples in the timepoints CSV, so they would be "
            f"loaded as extra samples: {', '.join(unknown[:10])}. Move them out of the folder."
        )


def populate_annotations_for_sample(conn: sqlite3.Connection, source: str, sample: str, annotations: dict) -> tuple:
    """Insert one sample's worth of annotation_series + scaffolds rows,
    replacing any existing rows for this (source, sample) pair first.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        sample: Sample name.
        annotations: Parsed JSON for this sample, {annotation_id: entry}.

    Returns:
        (series_count, scaffold_count) inserted for this sample.
    """
    cursor = conn.cursor()

    # Delete-then-reinsert, children before parent -- scoped to
    # (source, sample) since this same sample name is reused across all
    # 4 sources.
    cursor.execute(
        "DELETE FROM scaffolds WHERE annotation_series_id IN "
        "(SELECT id FROM annotation_series WHERE source=? AND sample=?)",
        (source, sample),
    )
    cursor.execute("DELETE FROM annotation_series WHERE source=? AND sample=?", (source, sample))

    annotation_series_rows = [
        build_annotation_series_row(source, sample, annotation_id, entry)
        for annotation_id, entry in annotations.items()
    ]

    # Named placeholders match build_annotation_series_row's dict keys
    # exactly -- executemany can bind straight from a list of dicts, no
    # manual tuple-ordering needed.
    cursor.executemany(
        """
        INSERT INTO annotation_series
            (source, sample, annotation_id, name, category, parent, depth, egc, norm_egc, scaffold_count, gene_count)
        VALUES
            (:source, :sample, :annotation_id, :name, :category, :parent, :depth, :egc, :norm_egc, :scaffold_count, :gene_count)
        """,
        annotation_series_rows,
    )

    # annotation_id is only unique within (source, sample), so this lookup
    # must filter on both, or a KEGG row could steal a COG row's id when
    # the two happen to share the same annotation_id string.
    annotation_id_to_series_id = {
        annotation_id: series_id
        for series_id, annotation_id in cursor.execute(
            "SELECT id, annotation_id FROM annotation_series WHERE source=? AND sample=?",
            (source, sample),
        )
    }

    # No side-dict needed here -- each entry's own "scaffolds" dict is
    # already sitting right here in `annotations`.
    scaffold_rows = [
        (annotation_id_to_series_id[annotation_id], scaffold_id, gene_count)
        for annotation_id, entry in annotations.items()
        for scaffold_id, gene_count in (entry.get("scaffolds") or {}).items()
    ]

    cursor.executemany(
        "INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, ?, ?)",
        scaffold_rows,
    )

    conn.commit()
    return len(annotation_series_rows), len(scaffold_rows)


def populate_annotations(conn: sqlite3.Connection, source: str, source_dir: str, suffix: str) -> None:
    """Populate annotation_series + scaffolds for every sample file in
    source_dir, one sample's JSON at a time.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        source_dir: Directory containing this source's per-sample JSON
            files.
        suffix: Filename suffix identifying this source's files.
    """
    sample_files = list(iter_sample_files(source_dir, suffix))
    check_samples_are_known(sample_files)
    total_series = 0
    total_scaffolds = 0

    for i, (sample, json_path) in enumerate(sample_files, start=1):
        with open(json_path, "r", encoding="utf-8") as f:
            annotations = json.load(f)
        series_count, scaffold_count = populate_annotations_for_sample(conn, source, sample, annotations)
        total_series += series_count
        total_scaffolds += scaffold_count
        print(f"[{i}/{len(sample_files)}] {sample}: {series_count} annotation_series rows, {scaffold_count} scaffolds rows")

    print(f"Done. {total_series} total annotation_series rows, {total_scaffolds} total scaffolds rows across {len(sample_files)} samples.")


def invalidate_correlations_cache(conn: sqlite3.Connection) -> int:
    """Wipe correlations_cache and correlations_unscored entirely.

    Every row in them was computed against a specific sample alignment --
    lag offsets and pairwise-complete filtering are both indexed by sample
    *position*, so a single new (or corrected) sample shifts alignment for
    every existing cached pair, not just ones touching that sample. A pair
    that couldn't be scored before may be scorable after. Not selective on
    purpose.

    Returns:
        Number of rows deleted from both tables, for the caller to log.
    """
    deleted = conn.execute("DELETE FROM correlations_cache").rowcount
    deleted += conn.execute("DELETE FROM correlations_unscored").rowcount
    conn.commit()
    return deleted


def main():
    """Run populate_annotations() for every source in SOURCES, then wipe
    correlations_cache once at the end (not per-sample/per-source) since
    any change made during this run invalidates the whole cache at once.
    """
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        for source, (source_dir, suffix) in SOURCES.items():
            print(f"=== {source} ===")
            populate_annotations(conn, source, source_dir, suffix)

        deleted = invalidate_correlations_cache(conn)
        print(f"Invalidated correlations_cache: {deleted} rows deleted.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
