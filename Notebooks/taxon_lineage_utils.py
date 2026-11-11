"""
taxon_lineage_utils.py
======================
EGC_TAX_TREE.ipynb's lineage normalization. The rule lives in
FastAPI/api/taxon_lineage.py, shared with the mapping rebuild
(migrate_mappings_to_sql.py) so the tree's taxon ids and taxon_paths agree;
this module re-exports it for the notebook (imported via sys.path.append,
like enzyme_ec_utils.py).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "FastAPI"))

from api.taxon_lineage import lineage_segments, normalize_lineage  # noqa: E402,F401  pylint: disable=wrong-import-position,import-error
