"""
create_sql_schema.py
======================
Creates the two SQLite tables for the mapping-data SQL backend:

  taxon_paths -- one row per unique taxonomy lineage (deduplicated across
                 ALL 128 samples, not per-sample). Columns are the 8 fixed
                 ranks (domain..strain) parsed by parse_taxon_path() in
                 migrate_mappings_to_sql.py, plus the original raw string.
                 Existing solely so `mappings` rows can reference a taxon
                 by a small integer FK instead of repeating a ~90-character
                 lineage string on every one of ~50M mapping rows, and so
                 rank-scoped lookups ("everything under Bacteroidetes") are
                 a plain indexed column filter -- see project memory
                 (taxonomy_egc_homonym_bug) for why this table is
                 deliberately NOT a parent-pointer tree.

  mappings    -- one row per gene (~50M total across all samples, matching
                 the regenerated Mappings_by_Sample/*.tsv row counts).
                 taxon_path_id is NULL for genes with no taxonomy hit.
                 kegg_id keeps its raw "KO:" prefix and stays a plain
                 column here -- confirmed every gene has at most one KEGG
                 hit, never multi-valued (see project memory). cog_id and
                 enzyme are NOT columns here -- see gene_cog/gene_enzyme
                 below.

  gene_cog,
  gene_enzyme -- junction tables: COG and Enzyme are the two sources that
                 can legitimately assign MULTIPLE distinct annotations to
                 one gene (e.g. a multi-domain protein with two COG hits,
                 or a bifunctional enzyme with two EC numbers) -- a
                 many-to-many relationship, which a single flat column on
                 `mappings` can't represent without packing multiple
                 values into one cell. One row per real (gene, annotation)
                 hit here instead, so "WHERE cog_id = 'COG0243'" is a
                 plain indexed lookup, not a substring/string-split
                 workaround.

No indexes are created here -- per MEMORY_USAGE_REVIEW.md's ingestion
guidance, indexes are cheaper to build AFTER the ~50M-row bulk insert than
to maintain during it. That's a separate future step.

Safe to re-run: uses CREATE TABLE IF NOT EXISTS, so re-running this against
an existing database is a no-op rather than an error.

Run:
    python scripts/create_sql_schema.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


SCHEMA = """
CREATE TABLE IF NOT EXISTS taxon_paths (
    id        INTEGER PRIMARY KEY,
    domain    TEXT,
    phylum    TEXT,
    class_    TEXT,
    "order"   TEXT,
    family    TEXT,
    genus     TEXT,
    species   TEXT,
    strain    TEXT,
    full_path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS mappings (
    id            INTEGER PRIMARY KEY,
    sample        TEXT NOT NULL,
    gene_id       TEXT,
    scaffold_id   TEXT,
    taxon_path_id INTEGER REFERENCES taxon_paths(id),
    kegg_id       TEXT
);

CREATE TABLE IF NOT EXISTS gene_cog (
    id         INTEGER PRIMARY KEY,
    mapping_id INTEGER NOT NULL REFERENCES mappings(id),
    cog_id     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gene_enzyme (
    id         INTEGER PRIMARY KEY,
    mapping_id INTEGER NOT NULL REFERENCES mappings(id),
    ec_id      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotation_series(
    id         INTEGER PRIMARY KEY,
    source     TEXT NOT NULL, -- 'cog' | 'enzyme' | 'kegg' | 'taxonomy'
    sample     TEXT NOT NULL,
    annotation_id  TEXT NOT NULL,
    name           TEXT,
    category       TEXT,           -- functional category (cog/kegg/enzyme); domain root for taxonomy
    parent         TEXT,           -- taxonomy's own parent field, or kegg/enzyme's parent_name; NULL for cog
    depth          INTEGER,        -- MEANING IS SOURCE-SPECIFIC: taxonomic rank (1=domain..8=strain) for
                                    -- taxonomy; kegg/enzyme's own pathway/EC hierarchy depth otherwise (NOT
                                    -- a taxonomic rank) -- see migrate_annotations_to_sql.py. NULL for cog.
    egc            REAL,
    norm_egc       REAL,
    scaffold_count INTEGER,
    gene_count     INTEGER,
    UNIQUE(source, sample, annotation_id)
);

CREATE TABLE IF NOT EXISTS annotation_catalog(
    id INTEGER PRIMARY KEY,
    source  TEXT NOT NULL, -- 'cog' | 'enzyme' | 'kegg' | 'taxonomy',
    annotation_id TEXT NOT NULL,
    name TEXT,
    parent TEXT,
    mean_egc REAL,
    max_egc REAL,
    mean_norm_egc REAL,
    max_norm_egc REAL,
    sample_count INTEGER,
    UNIQUE (source, annotation_id)
);

CREATE TABLE IF NOT EXISTS scaffolds(
    id         INTEGER PRIMARY KEY,
    annotation_series_id INTEGER NOT NULL REFERENCES annotation_series(id),
    scaffold_id         TEXT NOT NULL,
    gene_count          INTEGER NOT NULL   -- the count value from entry["scaffolds"][scaffold]
);
"""


def create_schema(db_path: str = SQLITE_DB_PATH) -> None:
    """Create every table in SCHEMA if it doesn't already exist.

    Args:
        db_path: Path to the SQLite database file.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    create_schema()
    print(f"Schema ready at {SQLITE_DB_PATH}")
