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
                 a plain indexed column filter. Deliberately NOT a
                 parent-pointer tree: the same bare taxon name can appear
                 under more than one lineage, so a name is not an
                 identifier.

  mappings    -- one row per gene (~50M total across all samples, matching
                 the regenerated Mappings_by_Sample/*.tsv row counts).
                 taxon_path_id is NULL for genes with no taxonomy hit.
                 kegg_id keeps its raw "KO:" prefix and stays a plain
                 column here -- confirmed every gene has at most one KEGG
                 hit, never multi-valued. cog_id and
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

CREATE TABLE IF NOT EXISTS enzyme_paths (
    id      INTEGER PRIMARY KEY,
    a_id    TEXT, a_name TEXT, -- e.g. 1, Oxidoreductases
    b_id    TEXT, b_name TEXT, -- e.g. 1.1, Acting on the CH-OH group of donors
    c_id    TEXT, c_name TEXT, -- e.g. 1.1.1, With NAD(+) or NADP(+) as acceptor
    d_id    TEXT, d_name TEXT, -- e.g. 1.1.1.1, alcohol dehydrogenase (leaf, may be NULL)
    full_path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS cog_paths (
    id      INTEGER PRIMARY KEY,
    a_id    TEXT, a_name TEXT, -- category letter + name, e.g. C, Energy production and conversion
    b_id    TEXT, b_name TEXT, -- e.g. COG0055, FoF1-type ATP synthase, beta subunit (leaf)
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
    cog_id     TEXT NOT NULL,
    sample     TEXT NOT NULL  -- denormalized from mappings.sample: lets
                              -- get_mappings_sql seek by (cog_id, sample)
                              -- together via a composite index instead of
                              -- visiting every cog_id match regardless of
                              -- which samples were requested (found live
                              -- in production, 2026-09-25: COG2801 took
                              -- 55.0s without this). NOT NULL here, but the
                              -- live db's column is nullable: it was added
                              -- there later by backfill_gene_cog_sample_column.py
                              -- (ALTER TABLE ADD COLUMN can't add NOT NULL
                              -- without a default). 0 real NULLs exist; a fresh
                              -- build deliberately keeps the stricter rule.
);

CREATE TABLE IF NOT EXISTS gene_enzyme (
    id         INTEGER PRIMARY KEY,
    mapping_id INTEGER NOT NULL REFERENCES mappings(id),
    ec_id      TEXT NOT NULL,
    sample     TEXT NOT NULL  -- see gene_cog.sample
);

CREATE TABLE IF NOT EXISTS annotation_series(
    id         INTEGER PRIMARY KEY,
    source     TEXT NOT NULL, -- 'cog' | 'enzyme' | 'kegg' | 'taxonomy'
    sample     TEXT NOT NULL,
    annotation_id  TEXT NOT NULL,
    name           TEXT,
    category       TEXT,           -- functional category (cog/enzyme); domain root for taxonomy; NULL for
                                    -- kegg (KEGG orthologs are a flat list)
    parent         TEXT,           -- taxonomy's own parent field, enzyme's parent_name, or cog's
                                    -- category letter (e.g. COG0001 -> 'H'). NULL for each source's
                                    -- top-level roots (e.g. cog's 25 category letters) and every kegg KO.
    depth          INTEGER,        -- MEANING IS SOURCE-SPECIFIC: taxonomic rank (1=domain..8=strain) for
                                    -- taxonomy; enzyme's own EC hierarchy depth (NOT a taxonomic rank) --
                                    -- see migrate_annotations_to_sql.py. For cog, 1 = category letter,
                                    -- 2 = COG. Always 1 for kegg. Never NULL in the live db.
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
    parent TEXT,           -- see annotation_series.parent
    mean_egc REAL,
    max_egc REAL,
    mean_norm_egc REAL,
    max_norm_egc REAL,
    sample_count INTEGER,
    depth INTEGER,         -- see annotation_series.depth. Declared LAST to
                            -- match the live db's column order (it was added
                            -- after the other columns there), so a fresh
                            -- build stays column-compatible with production.
    UNIQUE (source, annotation_id)
);

CREATE TABLE IF NOT EXISTS scaffolds(
    id         INTEGER PRIMARY KEY,
    annotation_series_id INTEGER NOT NULL REFERENCES annotation_series(id),
    scaffold_id         TEXT NOT NULL,
    gene_count          INTEGER NOT NULL   -- the count value from entry["scaffolds"][scaffold]
);

-- AvgFold from <sample>.a.depth.txt, for every scaffold that has a gene in
-- `mappings`. A gene's EGC is its scaffold's AvgFold, so joining this to
-- mappings splits any annotation's egc by taxon. Keyed on (sample,
-- scaffold_id) WITHOUT ROWID: the key is the lookup, no separate index.
CREATE TABLE IF NOT EXISTS scaffold_fold(
    sample      TEXT NOT NULL,
    scaffold_id TEXT NOT NULL,
    avg_fold    REAL NOT NULL,
    PRIMARY KEY (sample, scaffold_id)
) WITHOUT ROWID;

-- The norm_egc denominator per sample: sum over every gene in `mappings`
-- of its scaffold's AvgFold (the same value Notebooks/weighted_totals.py
-- computes). norm_egc = egc / weighted_total.
CREATE TABLE IF NOT EXISTS sample_totals(
    sample         TEXT PRIMARY KEY,
    weighted_total REAL NOT NULL
);

DROP TABLE IF EXISTS correlations;
CREATE TABLE IF NOT EXISTS correlations_cache(
    id     INTEGER PRIMARY KEY,
    catalog_id_a    INTEGER NOT NULL REFERENCES annotation_catalog(id),
    catalog_id_b    INTEGER NOT NULL REFERENCES annotation_catalog(id),
    r               REAL NOT NULL,
    metric          TEXT NOT NULL, -- 'egc' | 'norm_egc',
    method          TEXT NOT NULL, -- 'spearman' | 'log_pearson' | 'raw_pearson',
    lag_samples     INTEGER NOT NULL,
    p_value     REAL NOT NULL,
    n_pairs     INTEGER NOT NULL,
    -- Only ever set by the removed circular_shift permutation test; NULL
    -- for every row the current methods write. Kept so existing databases
    -- (see scripts/add_at_p_floor_column.py) don't need a schema change.
    at_p_floor  INTEGER,
    -- CORRELATION_METHOD_VERSION (api/correlation_sql.py) of the math that
    -- produced this row; rows from any other version are ignored. Last,
    -- so the columns before it keep their positions.
    method_version  INTEGER NOT NULL,
    UNIQUE (catalog_id_a, catalog_id_b, metric, method, method_version)
);
CREATE INDEX IF NOT EXISTS idx_correlations_cache_catalog_id_b ON correlations_cache(catalog_id_b);

-- Pairs that could not be scored, saved so they aren't re-tried on every
-- request, with why. Same key as correlations_cache.
CREATE TABLE IF NOT EXISTS correlations_unscored(
    id     INTEGER PRIMARY KEY,
    catalog_id_a    INTEGER NOT NULL REFERENCES annotation_catalog(id),
    catalog_id_b    INTEGER NOT NULL REFERENCES annotation_catalog(id),
    metric          TEXT NOT NULL,
    method          TEXT NOT NULL,
    method_version  INTEGER NOT NULL,
    reason          TEXT NOT NULL, -- 'too_few_points' | 'no_variation'
    max_shared      INTEGER NOT NULL, -- most shared timepoints at any lag
    UNIQUE (catalog_id_a, catalog_id_b, metric, method, method_version)
);
CREATE INDEX IF NOT EXISTS idx_correlations_unscored_catalog_id_b ON correlations_unscored(catalog_id_b);
"""


def create_schema(db_path: str = SQLITE_DB_PATH) -> None:
    """Create every table in SCHEMA if it doesn't already exist, and switch
    the db to WAL journal mode.

    Args:
        db_path: Path to the SQLite database file.

    WAL is a one-time, persistent, database-file-level setting (not a
    per-connection one) -- the default rollback-journal mode locks the
    ENTIRE file for the duration of any writer's transaction, blocking
    every other reader/writer; WAL lets readers keep working concurrently
    with a writer. Set here, at schema-creation time, deliberately -- not
    from request-handling code (see api/correlation_sql.py's _connect())
    -- since switching journal mode itself requires no OTHER connection
    have a write transaction open, and doing that from live request code
    means every request risks racing a concurrent writer and hitting
    "database is locked" trying to perform the switch itself. Safe/
    idempotent to re-run: if the db is already WAL, this is a no-op.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    create_schema()
    print(f"Schema ready at {SQLITE_DB_PATH}")
