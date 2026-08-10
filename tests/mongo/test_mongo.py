"""
test_mongo.py
==============
Tests for the MongoDB backend (api/db.py, api/cache_mongo.py).

Requires a running local MongoDB instance (see FastAPI/.env for connection
settings) and the pytest-asyncio plugin installed — pytest.ini already sets
asyncio_mode = auto for when it is.

Read-only tests run against the real MONGO_DB_NAME database (hab_dev) and
never modify it. Tests that insert/delete data use a separate throwaway
database (_TEST_DB_NAME) instead, so the 'samples' and 'annotations'
collections you populated by hand in Compass are never touched.

Run:
    pytest tests/mongo/test_mongo.py -v -m mongo
"""

import json
import os

import pytest

from api.config import COG_DIR, KEGG_DIR, ENZYME_DIR, TAXONOMY_DIR
from api.db import connect_to_mongo, close_mongo_connection
from api.cache_mongo import (
    get_all_sample_names_mongo,
    get_annotation_series_mongo,
    get_taxonomy_children_mongo,
    get_top_annotations_mongo,
    taxon_exists_mongo,
)

pytestmark = pytest.mark.mongo

# Separate, disposable database — keeps mutating tests away from the real
# hab_dev data used for manual exploration in Compass.
_TEST_DB_NAME = "hab_mongo_test"


# ── Connection ─────────────────────────────────────────────────────────────

async def test_mongo_connection():
    """The connection can be established and the server responds to a ping."""
    client, db = connect_to_mongo()
    result = await db.command("ping")
    assert result["ok"] == 1.0

    close_mongo_connection(client)


async def test_connection_closed_raises():
    """Using a db handle after its client has been closed should raise."""
    client, db = connect_to_mongo()
    close_mongo_connection(client)

    with pytest.raises(Exception):
        await get_all_sample_names_mongo(db)


# ── get_all_sample_names_mongo — read-only, against real data ──────────────

async def test_get_all_sample_names_mongo():
    """
    Returns exactly the real 128 sample names, derived live from the
    annotations collection (db.annotations.distinct("sample_name")) —
    NOT the separate 'samples' collection, which is a stale 4-document
    proof-of-concept stub left over from before the real migration
    scripts existed. A weaker version of this test (isinstance/len>0
    only) previously passed even though the function was silently
    undercounting to 4 samples instead of 128 — this caught it.
    """
    client, db = connect_to_mongo()
    sample_names = await get_all_sample_names_mongo(db)

    expected = {
        f.removesuffix(".cog.json") for f in os.listdir(COG_DIR) if f.endswith(".cog.json")
    }

    assert isinstance(sample_names, list)
    assert all(isinstance(name, str) for name in sample_names)
    assert set(sample_names) == expected

    close_mongo_connection(client)


# ── get_all_sample_names_mongo — isolated, mutating tests ──────────────────
#
# These use _TEST_DB_NAME instead of the real hab_dev database, so
# inserting/deleting test data never touches your real 'annotations' data.
# Querying a collection with zero documents and querying a collection that
# doesn't exist yet both return [] in Mongo — same code path — so one test
# covers both cases.

async def test_get_all_sample_names_mongo_empty():
    """Returns an empty list when the annotations collection has no documents."""
    client, _ = connect_to_mongo()
    test_db = client[_TEST_DB_NAME]
    await test_db.annotations.delete_many({})

    sample_names = await get_all_sample_names_mongo(test_db)
    assert sample_names == []

    close_mongo_connection(client)


async def test_get_all_sample_names_mongo_many_documents():
    """Handles several hundred distinct sample names correctly."""
    client, _ = connect_to_mongo()
    test_db = client[_TEST_DB_NAME]
    await test_db.annotations.delete_many({})  # start from a clean slate

    docs = [
        {"sample_name": f"sample_{i}", "source": "cog", "annotation_id": "X"}
        for i in range(500)
    ]
    await test_db.annotations.insert_many(docs)

    sample_names = await get_all_sample_names_mongo(test_db)
    assert len(sample_names) == 500

    await test_db.annotations.delete_many({})  # clean up after ourselves
    close_mongo_connection(client)


# ── get_annotation_series_mongo — read-only, against real data ─────────────

@pytest.mark.slow
async def test_get_annotation_series_mongo():
    """
    Cross-checks every Mongo document for COG0055 against the real source
    JSON files, across however many of the full 128 samples actually carry
    this annotation — not a hardcoded 4-sample subset, since the full
    migration (scripts/migrate_cog_to_mongo.py) superseded that proof of
    concept with the complete dataset.
    """
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "cog", "COG0055")

    # Ground truth, computed live from disk rather than hardcoded.
    expected_by_sample = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected_by_sample[sample_name] = entry

    assert len(docs) == len(expected_by_sample)

    for doc in docs:
        sample = doc["sample_name"]
        assert sample in expected_by_sample, f"unexpected sample '{sample}' in results"
        entry = expected_by_sample[sample]

        assert doc["egc"] == entry["egc"]
        assert doc["norm_egc"] == entry["norm_egc"]
        assert doc["name"] == entry["name"]
        assert doc["category"] == entry["category"]
        assert "_id" not in doc  # stripped in cache_mongo.py for interface parity

        assert "scaffolds" in doc
        assert len(doc["scaffolds"]) == len(entry["scaffolds"])

    # Spot-check one specific scaffold on one known sample against the real source file.
    sample_358 = next(d for d in docs if d["sample_name"] == "3300060358")
    assert sample_358["scaffolds"]["Ga0590986_0000001"] == 1

    close_mongo_connection(client)


async def test_get_annotation_series_mongo_wrong_source_returns_empty():
    """
    Regression guard: COG0055 is stored with source='cog'. Querying it under
    a different source must not match — this is exactly the kind of bug we
    hit once already (the source parameter was accepted but never used in
    the query filter).
    """
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "kegg", "COG0055")
    assert docs == []

    close_mongo_connection(client)


async def test_get_annotation_series_mongo_nonexistent_annotation():
    """A real source with an annotation_id that doesn't exist returns []."""
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "cog", "COG_DOES_NOT_EXIST")
    assert docs == []

    close_mongo_connection(client)


# ── Full-dataset migration verification (Step 6) ────────────────────────────
#
# These read every real DataStructures/COG/*.cog.json file, so they're
# noticeably slower than the rest of this file — run with -m mongo (default)
# or exclude with -m "not slow" for a quick pass.

@pytest.mark.slow
async def test_cog_migration_total_count_matches_source_files():
    """
    The total number of source='cog' documents in Mongo must exactly match
    the total annotation count across every real sample file — computed
    live from disk, not a hardcoded number, so this stays correct even if
    the source dataset changes.
    """
    client, db = connect_to_mongo()

    sample_files = [f for f in os.listdir(COG_DIR) if f.endswith(".cog.json")]
    expected_total = 0
    for filename in sample_files:
        with open(os.path.join(COG_DIR, filename)) as f:
            expected_total += len(json.load(f))

    actual_total = await db.annotations.count_documents({"source": "cog"})
    assert actual_total == expected_total

    close_mongo_connection(client)


@pytest.mark.slow
async def test_cog_migration_per_sample_counts_match_source_files():
    """
    Spot-checks several samples spread across the full 128, not just the
    original 4-sample proof of concept — catches issues that only show up
    partway through a full migration (e.g. a batch that silently failed).
    """
    client, db = connect_to_mongo()

    sample_files = sorted(f for f in os.listdir(COG_DIR) if f.endswith(".cog.json"))
    step = max(len(sample_files) // 5, 1)
    spot_check_files = sample_files[::step]

    for filename in spot_check_files:
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename)) as f:
            expected_count = len(json.load(f))

        actual_count = await db.annotations.count_documents(
            {"source": "cog", "sample_name": sample_name}
        )
        assert actual_count == expected_count, (
            f"{sample_name}: expected {expected_count}, got {actual_count}"
        )

    close_mongo_connection(client)


# ── KEGG — mirrors the COG tests above (scripts/migrate_kegg_to_mongo.py) ──
#
# KEGG entries carry three extra fields COG entries don't (depth, parent_id,
# parent_name), so those get checked too.

@pytest.mark.slow
async def test_get_annotation_series_mongo_kegg():
    """
    Cross-checks every Mongo document for K09014 against the real source
    JSON files, across however many of the full 128 samples actually carry
    this annotation.
    """
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "kegg", "K09014")

    expected_by_sample = {}
    for filename in os.listdir(KEGG_DIR):
        if not filename.endswith(".ko.json"):
            continue
        sample_name = filename.removesuffix(".ko.json")
        with open(os.path.join(KEGG_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("K09014")
        if entry is not None:
            expected_by_sample[sample_name] = entry

    assert len(docs) == len(expected_by_sample)

    for doc in docs:
        sample = doc["sample_name"]
        assert sample in expected_by_sample, f"unexpected sample '{sample}' in results"
        entry = expected_by_sample[sample]

        assert doc["egc"] == entry["egc"]
        assert doc["norm_egc"] == entry["norm_egc"]
        assert doc["name"] == entry["name"]
        assert doc["category"] == entry["category"]
        assert doc["depth"] == entry.get("depth")
        assert doc["parent_id"] == entry.get("parent_id")
        assert doc["parent_name"] == entry.get("parent_name")
        assert "_id" not in doc

        assert "scaffolds" in doc
        assert len(doc["scaffolds"]) == len(entry["scaffolds"])

    close_mongo_connection(client)


async def test_get_annotation_series_mongo_kegg_wrong_source_returns_empty():
    """Regression guard, mirrors the COG version: K09014 is source='kegg'."""
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "cog", "K09014")
    assert docs == []

    close_mongo_connection(client)


@pytest.mark.slow
async def test_kegg_migration_total_count_matches_source_files():
    """Total source='kegg' documents in Mongo must match the real files exactly."""
    client, db = connect_to_mongo()

    sample_files = [f for f in os.listdir(KEGG_DIR) if f.endswith(".ko.json")]
    expected_total = 0
    for filename in sample_files:
        with open(os.path.join(KEGG_DIR, filename)) as f:
            expected_total += len(json.load(f))

    actual_total = await db.annotations.count_documents({"source": "kegg"})
    assert actual_total == expected_total

    close_mongo_connection(client)


@pytest.mark.slow
async def test_kegg_migration_per_sample_counts_match_source_files():
    """Spot-checks several samples spread across the full 128."""
    client, db = connect_to_mongo()

    sample_files = sorted(f for f in os.listdir(KEGG_DIR) if f.endswith(".ko.json"))
    step = max(len(sample_files) // 5, 1)
    spot_check_files = sample_files[::step]

    for filename in spot_check_files:
        sample_name = filename.removesuffix(".ko.json")
        with open(os.path.join(KEGG_DIR, filename)) as f:
            expected_count = len(json.load(f))

        actual_count = await db.annotations.count_documents(
            {"source": "kegg", "sample_name": sample_name}
        )
        assert actual_count == expected_count, (
            f"{sample_name}: expected {expected_count}, got {actual_count}"
        )

    close_mongo_connection(client)


# ── Enzyme — same shape as KEGG (scripts/migrate_enzyme_to_mongo.py) ───────

@pytest.mark.slow
async def test_get_annotation_series_mongo_enzyme():
    """
    Cross-checks every Mongo document for enzyme '3.6.1.23' against the
    real source JSON files, across however many of the full 128 samples
    actually carry it.
    """
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "enzyme", "3.6.1.23")

    expected_by_sample = {}
    for filename in os.listdir(ENZYME_DIR):
        if not filename.endswith(".enzyme.json"):
            continue
        sample_name = filename.removesuffix(".enzyme.json")
        with open(os.path.join(ENZYME_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("3.6.1.23")
        if entry is not None:
            expected_by_sample[sample_name] = entry

    assert len(docs) == len(expected_by_sample)

    for doc in docs:
        sample = doc["sample_name"]
        assert sample in expected_by_sample, f"unexpected sample '{sample}' in results"
        entry = expected_by_sample[sample]

        assert doc["egc"] == entry["egc"]
        assert doc["norm_egc"] == entry["norm_egc"]
        assert doc["name"] == entry["name"]
        assert doc["category"] == entry["category"]
        assert doc["depth"] == entry.get("depth")
        assert doc["parent_id"] == entry.get("parent_id")
        assert doc["parent_name"] == entry.get("parent_name")
        assert "_id" not in doc

        assert "scaffolds" in doc
        assert len(doc["scaffolds"]) == len(entry["scaffolds"])

    close_mongo_connection(client)


async def test_get_annotation_series_mongo_enzyme_wrong_source_returns_empty():
    """Regression guard, mirrors the COG/KEGG versions."""
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "cog", "3.6.1.23")
    assert docs == []

    close_mongo_connection(client)


@pytest.mark.slow
async def test_enzyme_migration_total_count_matches_source_files():
    """Total source='enzyme' documents in Mongo must match the real files exactly."""
    client, db = connect_to_mongo()

    sample_files = [f for f in os.listdir(ENZYME_DIR) if f.endswith(".enzyme.json")]
    expected_total = 0
    for filename in sample_files:
        with open(os.path.join(ENZYME_DIR, filename)) as f:
            expected_total += len(json.load(f))

    actual_total = await db.annotations.count_documents({"source": "enzyme"})
    assert actual_total == expected_total

    close_mongo_connection(client)


@pytest.mark.slow
async def test_enzyme_migration_per_sample_counts_match_source_files():
    """Spot-checks several samples spread across the full 128."""
    client, db = connect_to_mongo()

    sample_files = sorted(f for f in os.listdir(ENZYME_DIR) if f.endswith(".enzyme.json"))
    step = max(len(sample_files) // 5, 1)
    spot_check_files = sample_files[::step]

    for filename in spot_check_files:
        sample_name = filename.removesuffix(".enzyme.json")
        with open(os.path.join(ENZYME_DIR, filename)) as f:
            expected_count = len(json.load(f))

        actual_count = await db.annotations.count_documents(
            {"source": "enzyme", "sample_name": sample_name}
        )
        assert actual_count == expected_count, (
            f"{sample_name}: expected {expected_count}, got {actual_count}"
        )

    close_mongo_connection(client)


# ── Taxonomy — different shape: name=annotation_id, single "parent" field ──
# (scripts/migrate_taxonomy_to_mongo.py)

@pytest.mark.slow
async def test_get_annotation_series_mongo_taxonomy():
    """
    Cross-checks every Mongo document for taxon 'Bacteria' against the real
    source JSON files, across however many of the full 128 samples actually
    carry it.
    """
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "taxonomy", "Bacteria")

    expected_by_sample = {}
    for filename in os.listdir(TAXONOMY_DIR):
        if not filename.endswith(".tax.json"):
            continue
        sample_name = filename.removesuffix(".tax.json")
        with open(os.path.join(TAXONOMY_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("Bacteria")
        if entry is not None:
            expected_by_sample[sample_name] = entry

    assert len(docs) == len(expected_by_sample)

    for doc in docs:
        sample = doc["sample_name"]
        assert sample in expected_by_sample, f"unexpected sample '{sample}' in results"
        entry = expected_by_sample[sample]

        assert doc["egc"] == entry["egc"]
        assert doc["norm_egc"] == entry["norm_egc"]
        assert doc["name"] == "Bacteria"  # taxonomy entries have no "name" field — annotation_id is the name
        assert doc["category"] == entry.get("category")
        assert doc["depth"] == entry.get("depth")
        assert doc["parent"] == entry.get("parent")
        assert "_id" not in doc

        assert "scaffolds" in doc
        assert len(doc["scaffolds"]) == len(entry["scaffolds"])

    close_mongo_connection(client)


async def test_get_annotation_series_mongo_taxonomy_wrong_source_returns_empty():
    """Regression guard, mirrors the COG/KEGG/Enzyme versions."""
    client, db = connect_to_mongo()
    docs = await get_annotation_series_mongo(db, "cog", "Bacteria")
    assert docs == []

    close_mongo_connection(client)


@pytest.mark.slow
async def test_taxonomy_migration_total_count_matches_source_files():
    """Total source='taxonomy' documents in Mongo must match the real files exactly."""
    client, db = connect_to_mongo()

    sample_files = [f for f in os.listdir(TAXONOMY_DIR) if f.endswith(".tax.json")]
    expected_total = 0
    for filename in sample_files:
        with open(os.path.join(TAXONOMY_DIR, filename)) as f:
            expected_total += len(json.load(f))

    actual_total = await db.annotations.count_documents({"source": "taxonomy"})
    assert actual_total == expected_total

    close_mongo_connection(client)


@pytest.mark.slow
async def test_taxonomy_migration_per_sample_counts_match_source_files():
    """Spot-checks several samples spread across the full 128."""
    client, db = connect_to_mongo()

    sample_files = sorted(f for f in os.listdir(TAXONOMY_DIR) if f.endswith(".tax.json"))
    step = max(len(sample_files) // 5, 1)
    spot_check_files = sample_files[::step]

    for filename in spot_check_files:
        sample_name = filename.removesuffix(".tax.json")
        with open(os.path.join(TAXONOMY_DIR, filename)) as f:
            expected_count = len(json.load(f))

        actual_count = await db.annotations.count_documents(
            {"source": "taxonomy", "sample_name": sample_name}
        )
        assert actual_count == expected_count, (
            f"{sample_name}: expected {expected_count}, got {actual_count}"
        )

    close_mongo_connection(client)


# ── get_taxonomy_children_mongo / taxon_exists_mongo ────────────────────────

def _unique_children_from_disk(parent) -> dict:
    """Ground truth: scan every real taxonomy file, dedup by annotation_id,
    matching the same dedup logic get_taxonomy_children_mongo uses."""
    expected: dict[str, dict] = {}
    for filename in os.listdir(TAXONOMY_DIR):
        if not filename.endswith(".tax.json"):
            continue
        with open(os.path.join(TAXONOMY_DIR, filename)) as f:
            data = json.load(f)
        for annotation_id, entry in data.items():
            if entry.get("parent") == parent and annotation_id not in expected:
                expected[annotation_id] = {
                    "annotation_id": annotation_id,
                    "depth":         entry.get("depth"),
                    "category":      entry.get("category"),
                }
    return expected


@pytest.mark.slow
async def test_get_taxonomy_children_mongo_roots():
    """parent=None must return exactly the 4 domain roots."""
    client, db = connect_to_mongo()
    children = await get_taxonomy_children_mongo(db, None)

    expected = _unique_children_from_disk(None)
    assert {c["annotation_id"] for c in children} == set(expected.keys())
    assert {c["annotation_id"] for c in children} == {"Bacteria", "Archaea", "Viruses", "Eukaryota"}

    for c in children:
        assert c["depth"] == expected[c["annotation_id"]]["depth"]
        assert c["category"] == expected[c["annotation_id"]]["category"]

    close_mongo_connection(client)


@pytest.mark.slow
async def test_get_taxonomy_children_mongo_bacteria():
    """
    Cross-checks every child of 'Bacteria' against real source files,
    across the full 128 samples — not just one sample's view of the tree.
    """
    client, db = connect_to_mongo()
    children = await get_taxonomy_children_mongo(db, "Bacteria")

    expected = _unique_children_from_disk("Bacteria")
    assert {c["annotation_id"] for c in children} == set(expected.keys())

    for c in children:
        assert c["depth"] == expected[c["annotation_id"]]["depth"]
        assert c["category"] == expected[c["annotation_id"]]["category"]

    close_mongo_connection(client)


async def test_get_taxonomy_children_mongo_no_children():
    """A real but childless (leaf) taxon returns an empty list, not an error."""
    client, db = connect_to_mongo()
    children = await get_taxonomy_children_mongo(db, "COG_DOES_NOT_EXIST_AS_A_TAXON")
    assert children == []

    close_mongo_connection(client)


async def test_taxon_exists_mongo():
    """Real taxa report as existing; made-up ones don't."""
    client, db = connect_to_mongo()

    assert await taxon_exists_mongo(db, "Bacteria") is True
    assert await taxon_exists_mongo(db, "NotARealTaxonNameXYZ") is False

    close_mongo_connection(client)


# ── get_top_annotations_mongo — aggregation pipeline ────────────────────────

@pytest.mark.slow
async def test_get_top_annotations_mongo_cog():
    """
    Cross-checks the aggregation pipeline's mean/max EGC per annotation_id
    against ground truth computed independently in Python from every real
    COG file — same numbers, computed two completely different ways.
    """
    client, db = connect_to_mongo()
    all_samples = await get_all_sample_names_mongo(db)

    egc_map: dict[str, dict] = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        with open(os.path.join(COG_DIR, filename)) as f:
            data = json.load(f)
        for annotation_id, entry in data.items():
            egc = entry.get("egc")
            if egc is None:
                continue
            info = egc_map.setdefault(annotation_id, {
                "name": entry.get("name"),
                "category": entry.get("category"),
                "egc_values": [],
                "norm_egc_values": [],
            })
            info["egc_values"].append(egc)
            norm_egc = entry.get("norm_egc")
            if norm_egc is not None:
                info["norm_egc_values"].append(norm_egc)

    expected: dict[str, dict] = {}
    for ann_id, info in egc_map.items():
        vals, norm_vals = info["egc_values"], info["norm_egc_values"]
        expected[ann_id] = {
            "name":           info["name"],
            "parent":         info["category"],  # cog's parent == category
            "mean_egc":       sum(vals) / len(vals),
            "max_egc":        max(vals),
            "mean_norm_egc":  sum(norm_vals) / len(norm_vals) if norm_vals else None,
            "max_norm_egc":   max(norm_vals) if norm_vals else None,
            "sample_count":   len(vals),
        }

    results = await get_top_annotations_mongo(db, "cog", all_samples)

    assert len(results) == len(expected)

    # Results must already be sorted by mean_egc descending.
    means = [r["mean_egc"] for r in results]
    assert means == sorted(means, reverse=True)

    # Deep-check a meaningful chunk (not just the very top), across
    # different points in the ranking, not just the highest values.
    for r in results[:25] + results[len(results) // 2 : len(results) // 2 + 25]:
        exp = expected[r["annotation_id"]]
        assert r["name"] == exp["name"]
        assert r["parent"] == exp["parent"]
        assert r["mean_egc"] == pytest.approx(exp["mean_egc"])
        assert r["max_egc"] == exp["max_egc"]
        assert r["sample_count"] == exp["sample_count"]
        if exp["mean_norm_egc"] is None:
            assert r["mean_norm_egc"] is None
        else:
            assert r["mean_norm_egc"] == pytest.approx(exp["mean_norm_egc"])

    close_mongo_connection(client)


async def test_get_top_annotations_mongo_empty_sample_list():
    """An empty sample list must return [] rather than matching everything."""
    client, db = connect_to_mongo()
    results = await get_top_annotations_mongo(db, "cog", [])
    assert results == []

    close_mongo_connection(client)
