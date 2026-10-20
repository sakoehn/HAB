"""
test_taxon_paths.py
=====================
Tests for parsing a raw mapping-TSV taxonomy string (a semicolon-joined
lineage, e.g. "Bacteria;Bacteroidetes;...;Wenyingzhuangia heitensis DSM
101599") into the 8 fixed rank fields (domain..strain) used by the SQLite
`taxon_paths` table.

Data-layer test: no database, no server -- just the parsing function in
isolation, rather than going through a route.

Design decisions this file locks in:
  - Ranks beyond the 8th are ABSORBED into `strain`, not dropped -- required
    by a real, NCBI-confirmed case (a BDGP reference strain whose actual
    name contains a semicolon: NCBI BioProject IDs 13812/164).
  - An empty or whitespace-only segment is POSITIONAL: it becomes None at
    its own rank rather than causing later ranks to shift left. None of
    these malformed-semicolon cases have actually been observed in the real
    TSVs -- they're defensive hardening, not confirmed real inputs.
  - Missing trailing ranks (fewer than 8 real segments) become None.
  - A raw value of None (mirrors cache.py's MappingRow, which already
    stores None rather than "" for a blank CSV field) is handled the same
    as an empty string: all ranks None.

Import target doesn't exist yet. Write `parse_taxon_path()` in
FastAPI/scripts/migrate_mappings_to_sql.py to make this pass.

Run:
    pytest tests/sql/test_taxon_paths.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_mappings_to_sql import parse_taxon_path


def test_parse_taxon_path_splits_eight_ranks():
    # Arrange: a real 8-rank lineage string, taken from
    # DataStructures/Mappings_by_Sample/3300060358_mapping.tsv
    raw = (
        "Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;"
        "Flavobacteriaceae;Wenyingzhuangia;Wenyingzhuangia heitensis;"
        "Wenyingzhuangia heitensis DSM 101599"
    )

    # Act
    result = parse_taxon_path(raw)

    # Assert: one rank per column, in order, plus the original string preserved
    assert result.domain == "Bacteria"
    assert result.phylum == "Bacteroidetes"
    assert result.class_ == "Flavobacteriia"
    assert result.order == "Flavobacteriales"
    assert result.family == "Flavobacteriaceae"
    assert result.genus == "Wenyingzhuangia"
    assert result.species == "Wenyingzhuangia heitensis"
    assert result.strain == "Wenyingzhuangia heitensis DSM 101599"
    assert result.full_path == raw


def test_parse_taxon_path_handles_semicolon_within_strain():
    # Arrange: a real row from DataStructures/Mappings_by_Sample/3300060358_mapping.tsv.
    # The strain name itself legitimately contains a semicolon -- confirmed
    # against NCBI BioProject (IDs 13812, 164): "y; cn bw sp" is the real,
    # registered genotype notation for the classic BDGP reference strain
    # (y = chromosome-1 marker; cn/bw/sp = chromosome-2 markers), not a
    # delimiter collision.
    raw = (
        "Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;"
        "Drosophila melanogaster;Drosophila melanogaster y; cn bw sp"
    )

    # Act
    result = parse_taxon_path(raw)

    # Assert: ranks 1-7 split normally; everything from rank 8 onward,
    # including the embedded semicolon, stays intact as `strain`
    assert result.domain == "Eukaryota"
    assert result.phylum == "Arthropoda"
    assert result.class_ == "Insecta"
    assert result.order == "Diptera"
    assert result.family == "Drosophilidae"
    assert result.genus == "Drosophila"
    assert result.species == "Drosophila melanogaster"
    assert result.strain == "Drosophila melanogaster y; cn bw sp"
    assert result.full_path == raw


def test_parse_taxon_path_handles_missing_ranks():
    # Arrange: a truncated lineage (only the first 5 of 8 ranks present).
    # Not itself an observed row -- constructed by truncating the real
    # Alteromonadaceae lineage below -- but every real TSV has ~9% blank
    # taxonomy and the underlying 5-rank prefix is real data.
    raw = "Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;Alteromonadaceae"

    # Act
    result = parse_taxon_path(raw)

    # Assert: missing trailing ranks are None, but the original string is preserved
    assert result.domain == "Bacteria"
    assert result.phylum == "Proteobacteria"
    assert result.class_ == "Gammaproteobacteria"
    assert result.order == "Alteromonadales"
    assert result.family == "Alteromonadaceae"
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_empty_string():
    # Arrange: ~9% of real mapping rows have a blank taxonomy field
    # (measured directly: 31,012 of 342,827 rows in 3300060358_mapping.tsv)
    raw = ""

    # Act
    result = parse_taxon_path(raw)

    # Assert: all ranks are None, but the original (empty) string is preserved
    assert result.domain is None
    assert result.phylum is None
    assert result.class_ is None
    assert result.order is None
    assert result.family is None
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_none():
    # Arrange: cache.py's MappingRow already normalizes a blank CSV field to
    # None rather than "" (see FastAPI/api/cache.py's load_tsv). If this
    # parser is ever fed a MappingRow.taxonomy value directly instead of a
    # raw CSV string, it needs to accept None, not just "".
    raw = None

    # Act
    result = parse_taxon_path(raw)

    # Assert: treated the same as an empty string -- all ranks None
    assert result.domain is None
    assert result.phylum is None
    assert result.class_ is None
    assert result.order is None
    assert result.family is None
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path is None


def test_parse_taxon_path_handles_extra_ranks():
    # Arrange: the real 8-rank Alteromonadaceae lineage (confirmed present
    # in 3300060358_mapping.tsv) with two synthetic extra segments appended,
    # to exercise what happens past rank 8.
    raw = (
        "Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;"
        "Alteromonadaceae;Alteromonas;Alteromonas macleodii;Alteromonas macleodii ATCC 27126;"
        "ExtraRank1;ExtraRank2"
    )

    # Act
    result = parse_taxon_path(raw)

    # Assert: ranks 1-7 split normally; everything from rank 8 onward is
    # absorbed into `strain` intact (same rule as the real Drosophila case
    # above -- the parser can't tell "genuine 9th rank" apart from "stray
    # semicolon inside rank 8", so it must pick one rule and it's this one)
    assert result.domain == "Bacteria"
    assert result.phylum == "Proteobacteria"
    assert result.class_ == "Gammaproteobacteria"
    assert result.order == "Alteromonadales"
    assert result.family == "Alteromonadaceae"
    assert result.genus == "Alteromonas"
    assert result.species == "Alteromonas macleodii"
    assert result.strain == "Alteromonas macleodii ATCC 27126;ExtraRank1;ExtraRank2"
    assert result.full_path == raw


def test_parse_taxon_path_handles_whitespace():
    # Arrange: a lineage string with extra whitespace around ranks
    raw = "  Bacteria ; Proteobacteria ; Gammaproteobacteria ; Alteromonadales ; Alteromonadaceae "

    # Act
    result = parse_taxon_path(raw)

    # Assert: whitespace is stripped from each rank, and the original string is preserved
    assert result.domain == "Bacteria"
    assert result.phylum == "Proteobacteria"
    assert result.class_ == "Gammaproteobacteria"
    assert result.order == "Alteromonadales"
    assert result.family == "Alteromonadaceae"
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_trailing_whitespace():
    # Arrange: a lineage string with trailing whitespace after the last rank
    raw = "Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;Alteromonadaceae   "

    # Act
    result = parse_taxon_path(raw)

    # Assert: trailing whitespace is stripped from the last rank, and the original string is preserved
    assert result.domain == "Bacteria"
    assert result.phylum == "Proteobacteria"
    assert result.class_ == "Gammaproteobacteria"
    assert result.order == "Alteromonadales"
    assert result.family == "Alteromonadaceae"
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_trailing_semicolon():
    # Arrange: a lineage string with a trailing semicolon (dangling empty rank)
    raw = "Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;Alteromonadaceae;"

    # Act
    result = parse_taxon_path(raw)

    # Assert: the dangling empty segment becomes the (missing) genus rank,
    # same as any other missing trailing rank; original string preserved
    assert result.domain == "Bacteria"
    assert result.phylum == "Proteobacteria"
    assert result.class_ == "Gammaproteobacteria"
    assert result.order == "Alteromonadales"
    assert result.family == "Alteromonadaceae"
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_leading_semicolon():
    # Arrange: a lineage string with a leading semicolon -- not an observed
    # real case, defensive hardening only.
    raw = ";Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;Alteromonadaceae"

    # Act
    result = parse_taxon_path(raw)

    # Assert: the leading empty segment is POSITIONAL -- it occupies the
    # `domain` slot as None, and everything else shifts down one rank from
    # where it would sit in a well-formed 8-rank string (same rule as
    # test_parse_taxon_path_handles_multiple_consecutive_semicolons below;
    # empty segments are never silently skipped, regardless of position)
    assert result.domain is None
    assert result.phylum == "Bacteria"
    assert result.class_ == "Proteobacteria"
    assert result.order == "Gammaproteobacteria"
    assert result.family == "Alteromonadales"
    assert result.genus == "Alteromonadaceae"
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_multiple_consecutive_semicolons():
    # Arrange: a lineage string with runs of consecutive semicolons.
    # "Bacteria" ";;" "Proteobacteria" ";;;" "Gammaproteobacteria" ";" "Alteromonadales" ";" "Alteromonadaceae"
    # -- a run of N consecutive semicolons between two real tokens produces
    # N-1 empty segments in between (standard str.split behavior), so the
    # ";;" gap is 1 empty rank and the ";;;" gap is 2 empty ranks.
    raw = "Bacteria;;Proteobacteria;;;Gammaproteobacteria;Alteromonadales;Alteromonadaceae"

    # Act
    result = parse_taxon_path(raw)

    # Assert: 8 positional segments total --
    # [Bacteria, "", Proteobacteria, "", "", Gammaproteobacteria, Alteromonadales, Alteromonadaceae]
    assert result.domain == "Bacteria"
    assert result.phylum is None            # 1 empty rank from the ";;" gap
    assert result.class_ == "Proteobacteria"
    assert result.order is None             # 1st empty rank from the ";;;" gap
    assert result.family is None            # 2nd empty rank from the ";;;" gap
    assert result.genus == "Gammaproteobacteria"
    assert result.species == "Alteromonadales"
    assert result.strain == "Alteromonadaceae"
    assert result.full_path == raw


def test_parse_taxon_path_handles_only_semicolons():
    # Arrange: a lineage string that consists only of semicolons
    raw = ";;;;;;"

    # Act
    result = parse_taxon_path(raw)

    # Assert: every segment is empty, so every rank is None
    assert result.domain is None
    assert result.phylum is None
    assert result.class_ is None
    assert result.order is None
    assert result.family is None
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_whitespace_only():
    # Arrange: a lineage string that consists only of whitespace
    raw = "     "

    # Act
    result = parse_taxon_path(raw)

    # Assert: all ranks are None, and the original string is preserved
    assert result.domain is None
    assert result.phylum is None
    assert result.class_ is None
    assert result.order is None
    assert result.family is None
    assert result.genus is None
    assert result.species is None
    assert result.strain is None
    assert result.full_path == raw


def test_parse_taxon_path_handles_mixed_empty_and_whitespace_ranks():
    # Arrange: a lineage string with mixed empty and whitespace-only ranks.
    # Positional segments: [Bacteria, " ", Proteobacteria, "", " ", Gammaproteobacteria, Alteromonadales, Alteromonadaceae]
    raw = "Bacteria; ;Proteobacteria;; ;Gammaproteobacteria;Alteromonadales;Alteromonadaceae"

    # Act
    result = parse_taxon_path(raw)

    # Assert: both "" and whitespace-only segments are treated as None, positionally
    assert result.domain == "Bacteria"
    assert result.phylum is None       # whitespace-only rank
    assert result.class_ == "Proteobacteria"
    assert result.order is None        # empty rank
    assert result.family is None       # whitespace-only rank
    assert result.genus == "Gammaproteobacteria"
    assert result.species == "Alteromonadales"
    assert result.strain == "Alteromonadaceae"
    assert result.full_path == raw


def test_parse_taxon_path_round_trip_reconstructs_full_path():
    # Arrange: two real, well-formed (exactly-8-rank, or 8+ absorbed into
    # strain) cases -- the invariant only holds when every real segment is
    # accounted for; it does NOT hold for the missing-ranks case above,
    # since re-joining 8 slots with "None" ranks would insert semicolons
    # that were never in the original (shorter) raw string.
    well_formed_cases = [
        (
            "Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;"
            "Flavobacteriaceae;Wenyingzhuangia;Wenyingzhuangia heitensis;"
            "Wenyingzhuangia heitensis DSM 101599"
        ),
        (
            "Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;"
            "Drosophila melanogaster;Drosophila melanogaster y; cn bw sp"
        ),
    ]

    for raw in well_formed_cases:
        # Act
        result = parse_taxon_path(raw)

        # Assert: joining the 8 rank fields back together with ";" recovers
        # the exact original string
        rejoined = ";".join([
            result.domain, result.phylum, result.class_, result.order,
            result.family, result.genus, result.species, result.strain,
        ])
        assert rejoined == raw


def test_parse_taxon_path_is_idempotent():
    # Arrange: the same real raw string, parsed twice
    raw = (
        "Bacteria;Proteobacteria;Gammaproteobacteria;Alteromonadales;"
        "Alteromonadaceae;Alteromonas;Alteromonas macleodii;Alteromonas macleodii ATCC 27126"
    )

    # Act: call the parser twice on identical input
    first  = parse_taxon_path(raw)
    second = parse_taxon_path(raw)

    # Assert: identical results every time -- guards against any hidden
    # non-determinism (e.g. relying on unordered set/dict iteration
    # somewhere in the implementation), which matters because ingestion
    # dedupes taxon_paths rows by full_path and assumes re-parsing the same
    # string always yields the same row
    assert first == second
