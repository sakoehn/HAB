"""
test_kegg_staleness_guard.py
===============================
P2 (docs/AUDIT-2026-10-05.md): EGC_KEGG_TREE.ipynb's original staleness
guard (cell 3) only checked whether a raw `.a.ko.txt` was newer than
`kegg_db.json` -- a direction that can't actually happen, since the raw
JGI files are static 2023 downloads. The real risk it left unguarded:
`kegg_db.json` gets rebuilt and this notebook's own written `.ko.json`
outputs are never regenerated to match. Confirmed directly against this
project's real files: all 128 `.ko.json` outputs on disk were dated 10
days older than the `kegg_db.json` they claim to be derived from, with
nothing anywhere checking that.

find_stale_outputs() (Notebooks/staleness_utils.py) makes that drift
visible; the write cell now calls it (reporting, not blocking, since the
write that follows IS the fix) before overwriting `.ko.json` files.

Imports the REAL function (not a hand-copied mirror, same reasoning as
test_enzyme_ec_resolution.py) so this has a fast, permanent regression
test on the actual implementation the notebook runs.

Run:
    pytest tests/test_kegg_staleness_guard.py -v
"""

import os
import sys
import time
from pathlib import Path

DATA_ROOT = Path(os.environ.get("HAB_DATA_ROOT", Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(DATA_ROOT / "Notebooks"))

from staleness_utils import find_stale_outputs  # noqa: E402


def test_output_older_than_reference_is_reported_stale(tmp_path):
    stale_file = tmp_path / "3300060358.ko.json"
    stale_file.write_text("{}")
    old_time = time.time() - 86400 * 10  # 10 days old, matching the real drift found
    os.utime(stale_file, (old_time, old_time))

    reference_mtime = time.time()  # kegg_db.json rebuilt "now"

    assert find_stale_outputs([stale_file], reference_mtime) == [stale_file]


def test_output_newer_than_reference_is_not_stale(tmp_path):
    reference_mtime = time.time() - 86400  # kegg_db.json built a day ago

    fresh_file = tmp_path / "3300060358.ko.json"
    fresh_file.write_text("{}")  # created now, after reference_mtime

    assert find_stale_outputs([fresh_file], reference_mtime) == []


def test_missing_output_is_not_reported_stale(tmp_path):
    missing_file = tmp_path / "does_not_exist.ko.json"

    assert find_stale_outputs([missing_file], time.time()) == []


def test_only_the_stale_subset_is_returned_from_a_mixed_batch(tmp_path):
    reference_mtime = time.time()

    stale_file = tmp_path / "stale.ko.json"
    stale_file.write_text("{}")
    old_time = reference_mtime - 86400 * 10
    os.utime(stale_file, (old_time, old_time))

    fresh_file = tmp_path / "fresh.ko.json"
    fresh_file.write_text("{}")
    new_time = reference_mtime + 86400
    os.utime(fresh_file, (new_time, new_time))

    missing_file = tmp_path / "missing.ko.json"

    result = find_stale_outputs([stale_file, fresh_file, missing_file], reference_mtime)
    assert result == [stale_file]
