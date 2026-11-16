"""
enzyme_ec_utils.py
====================
EGC_ENZYME_TREE.ipynb's EC helpers, re-exported for the notebook (imported
via sys.path.append, like weighted_totals.py / All_Coverages.py):

- the EC-label resolution rules from FastAPI/api/ec_renumbering.py, shared
  with the API's mappings search so a node's chart totals and its gene
  list use the same rule;
- the ExPASy ENZYME readers from FastAPI/api/expasy_enzyme.py, which give
  the tree its names.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "FastAPI"))

from api.ec_renumbering import (  # noqa: E402,F401  pylint: disable=wrong-import-position,import-error
    CURRENT_EC_NOT_IN_EXPASY,
    TRANSFERRED_EC,
    resolve_or_drop_ec,
    resolve_partial_ec,
)
from api.expasy_enzyme import (  # noqa: E402,F401  pylint: disable=wrong-import-position,import-error
    build_ec_nodes,
    parse_enzclass,
    parse_enzyme_dat,
    unexplained_retired_ids,
)
