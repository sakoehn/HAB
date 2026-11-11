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

  gene_cog(cog_id, sample), gene_cog(mapping_id)
  gene_enzyme(ec_id, sample), gene_enzyme(mapping_id)
      Both directions this junction-table design is actually queried:
      "find genes with this COG/EC" (the whole reason the junction table
      exists instead of a comma-joined column) and "find this gene's
      COGs/ECs" (used by every known-example test and the full-picture
      join query). The first direction is a composite index (replacing
      the old single-column cog_id/ec_id ones, which this makes
      redundant), same reasoning as mappings(kegg_id, sample) below:
      found live in production, 2026-09-25, COG2801 (a real, common COG)
      took 55.0s because the single-column index found every gene_cog row
      for that cog_id first and only checked sample afterward. Verified
      the same way as the kegg fix: gene_cog.sample is denormalized from
      mappings.sample (backfilled once for the existing production db;
      migrate_mappings_to_sql.py now populates it directly for a fresh
      build) so SQLite can seek by (cog_id, sample) together instead.

  taxon_paths(phylum), (class_), ("order"), (family), (genus), (species)
      The "everything under Bacteroidetes" rank-scoped lookup this table
      was specifically designed for. domain and strain deliberately NOT
      indexed: domain has ~4 distinct values total across the whole
      dataset (Bacteria/Archaea/Eukaryota/Viruses) -- too low a
      cardinality for an index to meaningfully narrow a scan -- and
      strain is effectively as unique as full_path itself, which is
      already indexed via its UNIQUE constraint.

  mappings(kegg_id, sample) -- replaces the old single-column
      idx_mappings_kegg_id (which this makes redundant: any query that
      filters on kegg_id alone can still use this index's leading
      column). Found live in production, 2026-09-25: /mappings/search
      for a single common KEGG id (K02014) across all 128 samples took
      249.8s. EXPLAIN QUERY PLAN showed the single-column index finds
      every row matching kegg_id first (all 271,284 of them for K02014),
      THEN checks each one's sample -- so restricting to fewer samples
      (the sample-count cap elsewhere in this codebase) didn't help at
      all, since the same 271,284 rows still have to be visited either
      way. Verified directly (same real data, temp index, before/after):
      the composite index lets SQLite seek by kegg_id AND sample
      together, cutting the actual rows visited for that 5-sample case
      from 271,284 to 7,391 and the query from 0.83s to 0.08s locally --
      the 37x fewer rows visited is what matters on production's
      IOPS-constrained storage, not the already-fast local wall-clock
      number.

  mappings(taxon_path_id, sample) -- replaces the old single-column
      idx_mappings_taxon_path_id, same reasoning as mappings(kegg_id,
      sample) above and same fix. Found live in production, 2026-09-25:
      taxonomy was never covered by /mappings/search's sample-count cap
      at all until that same fix, and even once it was, a domain-level
      node (source=taxonomy, annotation_id=Bacteria -- 39,237 real leaf
      taxa, 59,780,871 of ~74M total mappings rows, 81% of the entire
      dataset) was STILL slow after capping to 5 samples, because the
      single-column index has the exact same problem: it finds every row
      matching any of Bacteria's 39,237 taxon_path_id values first, then
      checks sample. Unlike gene_cog/gene_enzyme, no denormalized column
      was needed here -- mappings.sample already exists directly on the
      table being indexed. Verified directly (same real data, temp
      index, before/after): 245.9s -> 13.8s locally for that same
      5-sample Bacteria query.

  annotation_series(sample) -- a genuinely different bug from the three
      above, not a leaf/category-cap issue at all. Every correlation
      family request (correlation_loaders.load_sample_order, called once
      per request and memoized, not once per candidate) runs `SELECT
      DISTINCT sample FROM annotation_series` to get the 128-sample time
      axis. annotation_series is 7,060,430 rows, and `sample` isn't the
      leading column of any existing index (only source+annotation_id
      is), so this had to scan the whole table and deduplicate via a
      temp b-tree just to return 128 rows. Found live in production,
      2026-09-25: measured at 143.1s in complete isolation (nothing else
      running) -- and since this runs on literally every family request
      regardless of method, it was silently inflating (or, if the table
      happened to already be warm from recent unrelated activity, hiding)
      the true cost of every correlation measurement taken earlier this
      same session, which is exactly why circular_shift/spearman
      sometimes looked fine and raw_pearson/log_pearson sometimes didn't
      -- not a difference between the methods themselves. Verified
      directly (same real data, temp index, before/after): with the
      index, SQLite drops the temp b-tree step entirely and answers from
      the index's own sort order; 0.32s locally afterward.

  annotation_series(source, annotation_id, sample, egc, norm_egc) -- a
      covering index for the correlation family read
      (correlation_loaders.load_family_matrix), which fetches every
      candidate's values at once. Through (source, annotation_id) alone,
      each value is a separate jump to its table row, and one
      annotation's rows are spread through the file because they were
      inserted a sample at a time. Measured live, 2026-11-11 (server
      with 1.9 GB of memory): reading psbA's 5,783 taxonomy candidates
      (663,935 values) took 184.6s, and 176.8s again straight after --
      the rows didn't fit in memory -- so a cold taxonomy family hit the
      60s proxy limit even after scoring was vectorised. With every
      value inside the index, an annotation's values sit together. Adds
      955 MB; 80s to build locally. Locally (data already in memory) the
      same read went from 2.89s to 0.36s.

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

DROP INDEX IF EXISTS idx_gene_cog_cog_id;
CREATE INDEX IF NOT EXISTS idx_gene_cog_cog_sample ON gene_cog(cog_id, sample);
CREATE INDEX IF NOT EXISTS idx_gene_cog_mapping_id ON gene_cog(mapping_id);

DROP INDEX IF EXISTS idx_gene_enzyme_ec_id;
CREATE INDEX IF NOT EXISTS idx_gene_enzyme_ec_sample ON gene_enzyme(ec_id, sample);
CREATE INDEX IF NOT EXISTS idx_gene_enzyme_mapping_id ON gene_enzyme(mapping_id);

DROP INDEX IF EXISTS idx_mappings_kegg_id;
CREATE INDEX IF NOT EXISTS idx_mappings_kegg_sample ON mappings(kegg_id, sample);

DROP INDEX IF EXISTS idx_mappings_taxon_path_id;
CREATE INDEX IF NOT EXISTS idx_mappings_taxon_sample ON mappings(taxon_path_id, sample);

CREATE INDEX IF NOT EXISTS idx_taxon_paths_phylum ON taxon_paths(phylum);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_class ON taxon_paths(class_);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_order ON taxon_paths("order");
CREATE INDEX IF NOT EXISTS idx_taxon_paths_family ON taxon_paths(family);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_genus ON taxon_paths(genus);
CREATE INDEX IF NOT EXISTS idx_taxon_paths_species ON taxon_paths(species);

CREATE INDEX IF NOT EXISTS idx_scaffolds_annotation_series_id ON scaffolds(annotation_series_id);
CREATE INDEX IF NOT EXISTS idx_annotation_series_source_annotation_id ON annotation_series(source, annotation_id);
CREATE INDEX IF NOT EXISTS idx_annotation_catalog_source_annotation_id ON annotation_catalog(source, annotation_id);

CREATE INDEX IF NOT EXISTS idx_annotation_series_sample ON annotation_series(sample);

CREATE INDEX IF NOT EXISTS idx_annotation_series_family_values
    ON annotation_series(source, annotation_id, sample, egc, norm_egc)
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
