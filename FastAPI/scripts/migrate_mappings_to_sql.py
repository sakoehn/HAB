"""
migrate_mappings_to_sql.py
----------------------------
Populates the SQLite `taxon_paths` table (see create_sql_schema.py) with one
row per unique taxonomy lineage found across ALL 128 samples' phylodist
files (Metagenome_Samples/<sample>/<sample>.a.phylodist.txt) -- deduplicated
globally, not per-sample, since the same organism legitimately shows up in
many samples.

Deliberately reads phylodist, not the mapping TSVs' own taxonomy column:
phylodist is the richer upstream source (more unique paths, zero blank
rate; see project memory for the real numbers). The mapping-TSV ingestion
script (not yet written) will resolve each mapping row's own taxon_path_id
by matching its taxonomy string against this table.

Safe to re-run: full_path is UNIQUE on taxon_paths, and every insert uses
INSERT OR IGNORE, so re-running just silently skips rows already present --
no delete-first step needed.

Usage (from FastAPI/):
    python scripts/migrate_mappings_to_sql.py
"""

import csv
import os
import sqlite3
import sys
from typing import NamedTuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.cache import get_all_sample_names  # pylint: disable=wrong-import-position,import-error
from api.config import MAPPINGS_DIR, METAGENOME_SAMPLES_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


class TaxonPath(NamedTuple):
    domain: str | None
    phylum: str | None
    class_: str | None
    order: str | None
    family: str | None
    genus: str | None
    species: str | None
    strain: str | None
    full_path: str | None


def parse_taxon_path(raw: str | None) -> TaxonPath:
    """Split a semicolon-delimited phylodist lineage string into its 8
    fixed ranks.

    Args:
        raw: Raw lineage string, e.g. "Bacteria;Bacteroidetes;...", or
            None. Split is capped at 7 semicolons, so anything past the
            7th (a real semicolon-in-strain-name, or extra ranks) is
            absorbed into `strain` intact rather than dropped.

    Returns:
        A TaxonPath with each rank (None where absent) and the original
        raw string as full_path.
    """
    if not raw:
        return TaxonPath(
            domain=None,
            phylum=None,
            class_=None,
            order=None,
            family=None,
            genus=None,
            species=None,
            strain=None,
            full_path=raw,
        )

    parts = raw.split(';', 7)
    cleaned = [p.strip() or None for p in parts]
    while len(cleaned) < 8:
        cleaned.append(None)
    domain, phylum, class_, order, family, genus, species, strain = cleaned
    return TaxonPath(
        domain=domain,
        phylum=phylum,
        class_=class_,
        order=order,
        family=family,
        genus=genus,
        species=species,
        strain=strain,
        full_path=raw,
    )


def iter_unique_taxon_paths():
    """Yield one TaxonPath per unique lineage, deduplicated globally
    across every sample's phylodist file.

    Yields:
        TaxonPath, one per newly-seen full_path.
    """
    samples = get_all_sample_names()
    seen: set[str] = set()

    for i, sample in enumerate(samples, start=1):
        phylodist_path = os.path.join(
            METAGENOME_SAMPLES_DIR, sample, f"{sample}.a.phylodist.txt"
        )
        new_this_sample = 0

        with open(phylodist_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f, delimiter="\t")
            for row in reader:
                raw_taxon_path = row[4]
                taxon_path = parse_taxon_path(raw_taxon_path)
                if taxon_path.full_path not in seen:
                    seen.add(taxon_path.full_path)
                    new_this_sample += 1
                    yield taxon_path

        print(f"[{i}/{len(samples)}] read {sample} ({new_this_sample} new unique paths, {len(seen)} total so far)")

    print(f"Done reading. {len(seen)} unique taxon paths across {len(samples)} samples.")


def populate_taxon_paths():
    """Insert every unique taxon path (from iter_unique_taxon_paths) into
    the taxon_paths table. Safe to re-run -- duplicates are skipped via
    INSERT OR IGNORE."""
    connection = sqlite3.connect(SQLITE_DB_PATH)
    try:
        # TaxonPath is a NamedTuple -- it already behaves as a plain tuple
        # in the exact column order the table needs, so no conversion step
        # is needed before handing rows to executemany.
        rows = list(iter_unique_taxon_paths())

        cursor = connection.cursor()
        cursor.executemany(
            """
            INSERT OR IGNORE INTO taxon_paths
                (domain, phylum, class_, "order", family, genus, species, strain, full_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        connection.commit()

        total = connection.execute("SELECT COUNT(*) FROM taxon_paths").fetchone()[0]
        print(f"Inserted {cursor.rowcount} new rows. taxon_paths now has {total} total rows.")
    finally:
        connection.close()


def build_taxon_path_lookup(connection: sqlite3.Connection) -> dict[str, int]:
    """Build a full_path -> id lookup for resolving each mapping row's
    taxon_path_id, held in memory and reused across every sample.

    Args:
        connection: Open SQLite connection.

    Returns:
        Dict mapping full_path to its taxon_paths row id.
    """
    return {
        full_path: id_
        for id_, full_path in connection.execute("SELECT id, full_path FROM taxon_paths")
    }


# Already run successfully once against the full ~74M-row real dataset
# (see project notes) -- not splitting this up for a variable-count metric
# alone, since that risks introducing a bug in already-proven, expensive
# -to-rerun migration logic for a purely cosmetic gain.
# pylint: disable-next=too-many-locals
def populate_mappings_for_sample(
    connection: sqlite3.Connection,
    sample: str,
    taxon_lookup: dict[str, int],
    skip_delete: bool = False,
) -> int:
    """Populate mappings/gene_cog/gene_enzyme for one sample from its
    regenerated {sample}_mapping.tsv.

    Args:
        connection: Open SQLite connection.
        sample: Sample name, used to locate its mapping TSV.
        taxon_lookup: full_path -> taxon_paths id, from
            build_taxon_path_lookup().
        skip_delete: If False (default), deletes this sample's existing
            rows first (children before parent -- SQLite doesn't enforce
            FK constraints or cascade deletes here), making the call safe
            to re-run. Set True only when populating a fresh, empty
            database, where the delete's existence check has no index to
            use yet.

    Returns:
        Number of mapping rows inserted for this sample.
    """
    tsv_path = os.path.join(MAPPINGS_DIR, f"{sample}_mapping.tsv")

    cursor = connection.cursor()
    if not skip_delete:
        cursor.execute(
            "DELETE FROM gene_cog WHERE mapping_id IN (SELECT id FROM mappings WHERE sample = ?)", (sample,)
        )
        cursor.execute(
            "DELETE FROM gene_enzyme WHERE mapping_id IN (SELECT id FROM mappings WHERE sample = ?)", (sample,)
        )
        cursor.execute("DELETE FROM mappings WHERE sample = ?", (sample,))

    mapping_rows = []
    cog_by_gene: dict[str, list[str]] = {}
    enzyme_by_gene: dict[str, list[str]] = {}

    with open(tsv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            gene_id = row["gene_id"]
            taxonomy = row["taxonomy"] or None
            mapping_rows.append((
                sample,
                gene_id,
                row["scaffold_id"] or None,
                taxon_lookup.get(taxonomy) if taxonomy else None,
                row["kegg"] or None,
            ))
            if row["cog"]:
                cog_by_gene[gene_id] = row["cog"].split(",")
            if row["enzyme"]:
                enzyme_by_gene[gene_id] = row["enzyme"].split(",")

    cursor.executemany(
        "INSERT INTO mappings (sample, gene_id, scaffold_id, taxon_path_id, kegg_id) VALUES (?, ?, ?, ?, ?)",
        mapping_rows,
    )

    # gene_id is unique within a sample (verified: no duplicate gene_id in
    # any TSV), so this dict is safe to build with no key collisions.
    gene_to_mapping_id = {
        gene_id: mapping_id
        for mapping_id, gene_id in cursor.execute("SELECT id, gene_id FROM mappings WHERE sample = ?", (sample,))
    }

    cog_rows = [
        (gene_to_mapping_id[gene_id], cog_id, sample)
        for gene_id, cog_ids in cog_by_gene.items()
        for cog_id in cog_ids
    ]
    enzyme_rows = [
        (gene_to_mapping_id[gene_id], ec_id, sample)
        for gene_id, ec_ids in enzyme_by_gene.items()
        for ec_id in ec_ids
    ]

    cursor.executemany("INSERT INTO gene_cog (mapping_id, cog_id, sample) VALUES (?, ?, ?)", cog_rows)
    cursor.executemany("INSERT INTO gene_enzyme (mapping_id, ec_id, sample) VALUES (?, ?, ?)", enzyme_rows)

    connection.commit()
    return len(mapping_rows)


def populate_mappings():
    """Populate mappings/gene_cog/gene_enzyme for every sample, via
    populate_mappings_for_sample(). Skips the per-sample delete step when
    the mappings table is currently empty (first-run case)."""
    connection = sqlite3.connect(SQLITE_DB_PATH)
    try:
        taxon_lookup = build_taxon_path_lookup(connection)
        samples = get_all_sample_names()

        existing = connection.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
        skip_delete = existing == 0

        total = 0
        for i, sample in enumerate(samples, start=1):
            count = populate_mappings_for_sample(connection, sample, taxon_lookup, skip_delete=skip_delete)
            total += count
            print(f"[{i}/{len(samples)}] {sample}: {count} mapping rows")

        print(f"Done. {total} total mapping rows across {len(samples)} samples.")
    finally:
        connection.close()


if __name__ == "__main__":
    populate_taxon_paths()
    populate_mappings()
