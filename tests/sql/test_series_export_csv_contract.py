"""
test_series_export_csv_contract.py
==================================
What every file from GET /series/export must look like and hold, checked
against several real downloads (taxonomy and enzyme, with and without the
starting term, a date range, ranks skipped, names containing commas, and
the detected-only "sparse" mode).

The contract
------------
Shape
  * The header is exactly:
      taxonomy:       taxon,rank,lineage,sample,date,egc,norm_egc,detected
      kegg/cog/enzyme: annotation_id,name,level,lineage_ids,lineage,
                       also_in_other_paths,is_starting_term,
                       sample,date,egc,norm_egc,detected
  * Every row has exactly as many fields as the header, and names with
    commas or quotes come back unchanged when the file is read as CSV.
  * Rows come in blocks, one block per term: the starting term's block
    first (only when include_parent is on), then the terms in id order.

Which terms
  * Exactly the terms at the requested level under the starting term,
    each once (computed independently from the database here), each
    labelled with that level; the starting-term block carries the starting
    term's own level.
  * Labels match the database: taxonomy taxon = the taxon's name and
    lineage = its id; enzyme name = the term's name, lineage_ids runs from
    the top level down to the term's own id, lineage holds the matching
    names, both joined by " > ".

Samples and dates
  * In a normal file every block lists every sample in the date range,
    in date order, with date = that sample's time as YYYY-MM-DD HH:MM.
  * In a sparse file each block lists only the samples the term was
    detected in, still in date order, and no row has detected=false.

Values
  * detected=true rows carry exactly the egc and norm_egc stored for that
    term and sample; detected=false rows are terms with no stored value
    for that sample, written as 0 and 0.
  * Nothing is left out: every stored value for every term in the file,
    in the date range, appears in that term's block.

Run:
    pytest tests/sql/test_series_export_csv_contract.py -v
"""

import csv
import io
import os
import sqlite3
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

TAXONOMY_HEADER = ["taxon", "rank", "lineage", "sample", "date", "egc", "norm_egc", "detected"]
PATHS_HEADER = [
    "annotation_id", "name", "level", "lineage_ids", "lineage", "also_in_other_paths", "is_starting_term",
    "sample", "date", "egc", "norm_egc", "detected",
]
TAXONOMY_RANKS = {"domain": 1, "phylum": 2, "class": 3, "order": 4, "family": 5, "genus": 6, "species": 7, "strain": 8}
ENZYME_LEVELS = {"class": 1, "subclass": 2, "subsubclass": 3, "ec": 4}
ENZYME_COLUMNS = {1: ("a_id", "a_name"), 2: ("b_id", "b_name"), 3: ("c_id", "c_name"), 4: ("d_id", "d_name")}

GAMMA = "Bacteria;Proteobacteria;Gammaproteobacteria"
AEROPYRUM_CAMINI = "Archaea;Crenarchaeota;Thermoprotei;Desulfurococcales;Desulfurococcaceae;Aeropyrum;Aeropyrum camini"

REQUESTS = {
    "taxonomy: families under a class":           {"source": "taxonomy", "parent": GAMMA, "rank": "family"},
    "taxonomy: ranks skipped, family to species": {"source": "taxonomy", "parent": f"{GAMMA};Pseudomonadales;Pseudomonadaceae", "rank": "species"},
    "taxonomy: with the starting term":           {"source": "taxonomy", "parent": GAMMA, "rank": "family", "include_parent": "true"},
    "taxonomy: strain names containing commas":   {"source": "taxonomy", "parent": AEROPYRUM_CAMINI, "rank": "strain"},
    "taxonomy: date range":                       {"source": "taxonomy", "parent": GAMMA, "rank": "order", "date_from": "2021-06-03", "date_to": "2021-06-05"},
    "enzyme: EC numbers, names with commas":      {"source": "enzyme", "parent": "1.1.1", "rank": "ec"},
    "enzyme: with the starting term":             {"source": "enzyme", "parent": "5.6.2", "rank": "ec", "include_parent": "true"},
    "enzyme: levels skipped, class to EC":        {"source": "enzyme", "parent": "5", "rank": "ec", "date_from": "2021-05-27"},
    "enzyme: whole dataset":                      {"source": "enzyme", "rank": "class"},
}
SPARSE_REQUESTS = {
    "taxonomy, sparse": {"source": "taxonomy", "parent": GAMMA, "rank": "family"},
    "enzyme, sparse":   {"source": "enzyme", "parent": "1.1.1", "rank": "ec", "include_parent": "true"},
}


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


# ── Independent expectations, straight from the database ─────────────────────

def _expected_samples(conn, date_from, date_to):
    """(sample, 'YYYY-MM-DD HH:MM') in date order, limited to the range."""
    from api.cache import TIMEPOINTS

    real = {r[0] for r in conn.execute("SELECT DISTINCT sample FROM annotation_series")}
    out = []
    for sample in real:
        dt = datetime.strptime(TIMEPOINTS[sample]["datetime"], "%m/%d/%y %H:%M")
        day = dt.date().isoformat()
        if (date_from and day < date_from) or (date_to and day > date_to):
            continue
        out.append((dt, sample))
    return [(s, dt.strftime("%Y-%m-%d %H:%M")) for dt, s in sorted(out)]


def _expected_terms(conn, req):
    """{id: name} of every term the file must contain (starting term excluded)."""
    parent = req.get("parent")
    if req["source"] == "taxonomy":
        depth = TAXONOMY_RANKS[req["rank"]]
        prefix = (parent or "") + ";" if parent else ""
        rows = conn.execute(
            "SELECT annotation_id, name FROM annotation_catalog WHERE source = 'taxonomy' AND depth = ? "
            "AND substr(annotation_id, 1, ?) = ?",
            (depth, len(prefix), prefix),
        )
        return dict(rows)
    depth = ENZYME_LEVELS[req["rank"]]
    id_col, name_col = ENZYME_COLUMNS[depth]
    sql = f"SELECT DISTINCT {id_col}, {name_col} FROM enzyme_paths WHERE {id_col} IS NOT NULL"
    params = ()
    if parent:
        sql += f" AND {ENZYME_COLUMNS[len(parent.split('.'))][0]} = ?"
        params = (parent,)
    return dict(conn.execute(sql, params))


def _stored_values(conn, source, ids):
    values = {}
    ids = list(ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for aid, sample, egc, norm in conn.execute(
            f"SELECT annotation_id, sample, egc, norm_egc FROM annotation_series "
            f"WHERE source = ? AND annotation_id IN ({','.join('?' * len(chunk))})",
            [source, *chunk],
        ):
            values[(aid, sample)] = (egc, norm)
    return values


def _enzyme_lineage(conn, ec_id):
    depth = len(ec_id.split("."))
    cols = ", ".join(f"{ENZYME_COLUMNS[d][0]}, {ENZYME_COLUMNS[d][1]}" for d in range(1, depth + 1))
    row = conn.execute(f"SELECT DISTINCT {cols} FROM enzyme_paths WHERE {ENZYME_COLUMNS[depth][0]} = ?", (ec_id,)).fetchone()
    return list(row[0::2]), list(row[1::2])


# ── The contract ─────────────────────────────────────────────────────────────

def _check_contract(resp, req, conn, sparse):
    assert resp.status_code == 200, resp.text
    source = req["source"]
    taxonomy = source == "taxonomy"
    header = TAXONOMY_HEADER if taxonomy else PATHS_HEADER
    parent = req.get("parent")
    include_start = req.get("include_parent") == "true" and parent is not None

    reader = csv.reader(io.StringIO(resp.text))
    assert next(reader) == header
    raw = list(reader)
    assert raw, "file has no data rows"
    assert all(len(r) == len(header) for r in raw)
    rows = [dict(zip(header, r)) for r in raw]

    id_of = (lambda r: r["lineage"]) if taxonomy else (lambda r: r["annotation_id"])

    # Split into blocks of consecutive rows for the same term.
    blocks = []
    for r in rows:
        if blocks and id_of(blocks[-1][0]) == id_of(r):
            blocks[-1].append(r)
        else:
            blocks.append([r])

    # Starting term first, then the terms in id order, each exactly once.
    if include_start:
        start, blocks = blocks[0], blocks[1:]
        assert id_of(start[0]) == parent
        if taxonomy:
            assert start[0]["rank"] == [k for k, v in TAXONOMY_RANKS.items() if v == len(parent.split(";"))][0]
        else:
            assert all(r["is_starting_term"] == "true" for r in start)
            assert start[0]["level"] == [k for k, v in ENZYME_LEVELS.items() if v == len(parent.split("."))][0]
        all_blocks = [start, *blocks]
    else:
        all_blocks = blocks
    ids = [id_of(b[0]) for b in blocks]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids)), "a term appears in more than one block"

    expected = _expected_terms(conn, req)
    assert set(ids) == set(expected)

    # Labels.
    for b in blocks:
        r = b[0]
        if taxonomy:
            assert r["taxon"] == expected[r["lineage"]]
            assert all(x["rank"] == req["rank"] for x in b)
            if parent:
                assert r["lineage"].startswith(parent + ";")
        else:
            lineage_ids, lineage_names = _enzyme_lineage(conn, r["annotation_id"])
            assert r["name"] == expected[r["annotation_id"]] == lineage_names[-1]
            assert r["lineage_ids"] == " > ".join(lineage_ids)
            assert r["lineage"] == " > ".join(lineage_names)
            if parent:
                assert parent in lineage_ids
            assert all(x["level"] == req["rank"] for x in b)
            assert all(x["is_starting_term"] == "false" and x["also_in_other_paths"] == "false" for x in b)

    # Samples, dates and values.
    samples = _expected_samples(conn, req.get("date_from"), req.get("date_to"))
    sample_dates = dict(samples)
    sample_order = [s for s, _ in samples]
    stored = _stored_values(conn, source, [id_of(b[0]) for b in all_blocks])
    for b in all_blocks:
        term = id_of(b[0])
        listed = [r["sample"] for r in b]
        if sparse:
            assert listed == [s for s in sample_order if s in set(listed)], "samples out of date order"
        else:
            assert listed == sample_order
        for r in b:
            assert r["date"] == sample_dates[r["sample"]]
            assert r["detected"] in ("true", "false")
            if r["detected"] == "true":
                assert (float(r["egc"]), float(r["norm_egc"])) == stored[(term, r["sample"])]
            else:
                assert not sparse, "sparse file has an undetected row"
                assert (term, r["sample"]) not in stored
                assert (r["egc"], r["norm_egc"]) == ("0", "0")
        # Nothing stored for this term in the date range is missing.
        in_range = {s for (t, s) in stored if t == term and s in sample_dates}
        assert in_range == {r["sample"] for r in b if r["detected"] == "true"}


@pytest.mark.parametrize("name", list(REQUESTS))
def test_csv_contract(client, conn, name):
    req = REQUESTS[name]
    _check_contract(client.get("/series/export", params=req), req, conn, sparse=False)


@pytest.mark.parametrize("name", list(SPARSE_REQUESTS))
def test_csv_contract_sparse(client, conn, monkeypatch, name):
    from api import routes

    monkeypatch.setattr(routes, "_EXPORT_DENSE_ROW_LIMIT", 10)
    req = SPARSE_REQUESTS[name]
    _check_contract(client.get("/series/export", params=req), req, conn, sparse=True)


def test_names_with_commas_are_really_exercised(client):
    """Guards the fixtures above: both comma requests must actually contain
    a comma-bearing name, or the round-trip checks prove nothing."""
    tax = client.get("/series/export", params=REQUESTS["taxonomy: strain names containing commas"]).text
    enz = client.get("/series/export", params=REQUESTS["enzyme: EC numbers, names with commas"]).text
    assert '"Aeropyrum camini SY1, JCM 12091"' in tax
    assert '"D-xylose 1-dehydrogenase (NADP+, D-xylono-1,5-lactone-forming)"' in enz


def test_summary_matches_the_file(client):
    """The size shown before downloading is the file's real row count
    (normal mode) and its real number of terms."""
    for req in REQUESTS.values():
        summary = client.get("/series/export/summary", params=req).json()
        rows = list(csv.reader(io.StringIO(client.get("/series/export", params=req).text)))[1:]
        assert summary["max_rows"] == len(rows), req
        key = 2 if req["source"] == "taxonomy" else 0
        starting = 1 if req.get("include_parent") == "true" and req.get("parent") else 0
        assert summary["taxa"] == len({r[key] for r in rows}) - starting, req
