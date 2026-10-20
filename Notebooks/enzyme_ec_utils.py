"""
enzyme_ec_utils.py
====================
EGC_ENZYME_TREE.ipynb's EC-label resolution. The rules live in
FastAPI/api/ec_renumbering.py, shared with the API's mappings search so a
node's chart totals and its gene list use the same rule; this module
re-exports them for the notebook (imported via sys.path.append, like
weighted_totals.py / All_Coverages.py).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "FastAPI"))

from api.ec_renumbering import (  # noqa: E402,F401  pylint: disable=wrong-import-position,import-error
    TRANSFERRED_EC,
    resolve_or_drop_ec,
    resolve_partial_ec,
)
