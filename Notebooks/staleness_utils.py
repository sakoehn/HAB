"""
staleness_utils.py
=====================
Shared helper for detecting derived EGC outputs (e.g. `.ko.json`) that
predate the intermediate they were built from.

Extracted out of EGC_KEGG_TREE.ipynb's write cell (same pattern as
weighted_totals.py / enzyme_ec_utils.py -- imported via sys.path.append,
not copy-pasted) so tests/test_kegg_staleness_guard.py exercises the REAL
implementation, not a hand-maintained mirror.
"""

from pathlib import Path


def find_stale_outputs(output_paths, reference_mtime: float) -> list[Path]:
    """Return which of `output_paths` predate `reference_mtime`.

    EGC_KEGG_TREE.ipynb's original staleness guard (cell 3) only checked
    whether a raw `.a.ko.txt` was newer than `kegg_db.json` -- a direction
    that can't actually happen, since the raw JGI files are static 2023
    downloads. The real risk it left unguarded: `kegg_db.json` gets
    rebuilt (e.g. by Build_KEGG_DB.ipynb) and this notebook's own written
    `.ko.json` outputs are never regenerated to match, so they silently
    keep serving data derived from the OLD `kegg_db.json`. Confirmed
    directly against this project's real files: all 128 `.ko.json`
    outputs were dated 10 days older than the `kegg_db.json` they claim
    to be derived from.

    This doesn't block anything -- a missing or stale path is still
    about to be written fresh by the caller -- it just makes the drift
    visible instead of silent.

    Args:
        output_paths: Paths to check (existing or not).
        reference_mtime: The intermediate's mtime (`Path.stat().st_mtime`)
            to compare each existing output against.

    Returns:
        The subset of `output_paths` that exist and are older than
        `reference_mtime`.
    """
    stale = []
    for p in output_paths:
        path = Path(p)
        if path.exists() and path.stat().st_mtime < reference_mtime:
            stale.append(path)
    return stale
