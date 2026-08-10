"""
create_sql_indexes.py
=======================
Builds indexes on the populated mappings/gene_cog/gene_enzyme/taxon_paths
tables. Deliberately run AFTER the ~74M-row bulk insert
(migrate_mappings_to_sql.py), not during it -- maintaining indexes while
inserting tens of millions of rows is far more expensive than building
them once against the finished data. See MEMORY_USAGE_REVIEW.md's
ingestion guidance and create_sql_schema.py.

Indexes chosen to match query patterns actually exercised so far (see
tests/sql/test_mappings_sql.py), not "index everything":

  mappings(sample, gene_id) UNIQUE
      The (sample, gene_id) logical key. UNIQUE, not just a plain index:
      converts the "zero duplicate genes per sample" invariant already
      verified by test_no_duplicate_gene_id_within_a_sample into a real,
      permanently-enforced database constraint, rather than something
      that only stays true because nothing has inserted a duplicate yet.
      Also covers a plain "WHERE sample = ?" query for free, since sample
      is the leftmost column of the index.

  gene_cog(cog_id), gene_cog(mapping_id)
  gene_enzyme(ec_id), gene_enzyme(mapping_id)
      Both directions this junction-table design is actually queried:
      "find genes with this COG/EC" (the whole reason the junction table
      exists instead of a comma-joined column) and "find this gene's
      COGs/ECs" (used by every known-example test and the full-picture
      join query).

  taxon_paths(phylum), (class_), ("order"), (family), (genus), (species)
      The "everything under Bacteroidetes" rank-scoped lookup this table
      was specifically designed for. domain and strain deliberately NOT
      indexed: domain has ~4 distinct values total across the whole
      dataset (Bacteria/Archaea/Eukaryota/Viruses) -- too low a
      cardinality for an index to meaningfully narrow a scan -- and
      strain is effectively as unique as full_path itself, which is
      already indexed via its UNIQUE constraint.

Not indexed (yet): mappings.taxon_path_id (the reverse FK direction --
"which genes have this exact taxon" hasn't come up as a real query need
yet). Add it if/when an actual query needs it.

Run:
    python scripts/create_sql_indexes.py
"""

import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


INDEXES = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_mappings_sample_gene
    ON mappings(sample, gene_id);

CREATE INDEX IF NOT EXISTS idx_gene_cog_cog_id ON gene_cog(cog_id);
CREATE INDEX IF NOT EXISTS idx_gene_cog_mapping_id ON gene_cog(mapping_id);

CREATE INDEX IF NOT EXISTS idx_gene_enzyme_ec_id ON gene_enzyme(ec_id);
CREATE INDEX IF NOT EXISTS idx_gene_enzyme_mapping_id ON gene_enzyme(mapping_id);

CREATE INDEX IF NOT EXISTS idx_taxon_paths_phylum ON taxon_paths(phylum);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_class ON taxon_paths(class_);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_order ON taxon_paths("order");
CREATE INDEX IF NOT EXISTS idx_taxon_paths_family ON taxon_paths(family);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_genus ON taxon_paths(genus);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_species ON taxon_paths(species);

CREATE INDEX IF NOT EXISTS idx_scaffolds_annotation_series_id ON scaffolds(annotation_series_id);
CREATE INDEX IF NOT EXISTS idx_annotation_series_source_annotation_id ON annotation_series(source, annotation_id);
CREATE INDEX IF NOT EXISTS idx_annotation_catalog_source_annotation_id ON annotation_catalog(source, annotation_id)
"""


def create_indexes(db_path: str = SQLITE_DB_PATH) -> None:
    """Create every index in INDEXES if it doesn't already exist.

    Args:
        db_path: Path to the SQLite database file.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(INDEXES)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    start = time.time()
    create_indexes()
    print(f"Indexes built in {time.time() - start:.1f}s at {SQLITE_DB_PATH}")
