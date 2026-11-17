"""
expasy_enzyme.py
=================
Builds the enzyme tree's nodes from ExPASy ENZYME's two release files:
enzclass.txt (names of the classes, subclasses and sub-subclasses) and
enzyme.dat (one entry per EC number). ExPASy ENZYME is published by the
SIB Swiss Institute of Bioinformatics under CC BY 4.0.

The tree's shape needs no separate hierarchy file: an EC number's place is
fixed by its own digits, so 1.1.1.1 sits under 1.1.1, under 1.1, under 1.
Shared by EGC_ENZYME_TREE.ipynb (via Notebooks/enzyme_ec_utils.py) and the
SQL migration that fills enzyme_paths.
"""

import re

from .ec_renumbering import CURRENT_EC_NOT_IN_EXPASY, TRANSFERRED_EC

# "1. 1. 1.-    With NAD(+) or NADP(+) as acceptor." -- each of the first
# three positions is a number or "-"; the fourth is always "-".
_CLASS_LINE = re.compile(r"^\s*(\d+)\.\s*(\d+|-)\.\s*(\d+|-)\.-\s+(.+?)\s*$")
# EC ids inside a "Transferred entry:" line (ExPASy also has preliminary
# "n" numbers such as 3.5.1.n3).
_EC_ID = re.compile(r"\d+\.\d+\.\d+\.n?\d+")


def _drop_full_stop(text: str) -> str:
    return text[:-1] if text.endswith(".") else text


def ec_parent(ec_id: str) -> str | None:
    """The EC id one level up ("1.1.1.1" -> "1.1.1"), or None for a class."""
    return ec_id.rsplit(".", 1)[0] if "." in ec_id else None


def parse_enzclass(text: str) -> dict[str, str]:
    """Read enzclass.txt into {class id: name}, e.g. {"1.1.1": "With NAD(+)
    or NADP(+) as acceptor"}. Ids carry only their real digits ("1",
    "1.1", "1.1.1")."""
    classes = {}
    for line in text.splitlines():
        m = _CLASS_LINE.match(line)
        if m:
            ec_id = ".".join(p for p in m.groups()[:3] if p != "-")
            classes[ec_id] = _drop_full_stop(m.group(4))
    return classes


def parse_enzyme_dat(text: str) -> dict[str, dict]:
    """Read enzyme.dat into {EC id: {"name", "status", "transferred_to"}}.

    status is "current", "deleted" or "transferred"; transferred_to lists
    the new ids of a transferred entry (several when it was split). A name
    wrapped over several DE lines is joined with a space, or with nothing
    when the line break follows a hyphen ("4,5-" / "dioxygenase").
    """
    entries = {}
    ec_id, de = None, ""

    def finish():
        if ec_id is None:
            return
        name = _drop_full_stop(de.strip())
        if name.startswith("Transferred entry:"):
            entries[ec_id] = {"name": name, "status": "transferred",
                              "transferred_to": _EC_ID.findall(name)}
        elif name.startswith("Deleted entry"):
            entries[ec_id] = {"name": name, "status": "deleted", "transferred_to": []}
        else:
            entries[ec_id] = {"name": name, "status": "current", "transferred_to": []}

    for line in text.splitlines():
        if line.startswith("ID   "):
            finish()
            ec_id, de = line[5:].strip(), ""
        elif line.startswith("DE   ") and ec_id is not None:
            part = line[5:].strip()
            de = de + part if (not de or de.endswith("-")) else de + " " + part
        elif line.startswith("//"):
            finish()
            ec_id, de = None, ""
    finish()
    return entries


def build_ec_nodes(
    classes: dict[str, str], entries: dict[str, dict], extra: dict[str, str] | None = None,
) -> dict[str, dict]:
    """Every node of the enzyme tree: all classes, every current EC number,
    and the current numbers ExPASy lacks.

    Args:
        classes: From parse_enzclass.
        entries: From parse_enzyme_dat.
        extra: {EC id: name} of current numbers ExPASy lacks or lists as
            retired; defaults to CURRENT_EC_NOT_IN_EXPASY.

    Returns:
        {id: {"name", "depth", "category", "parent_id", "parent_name"}},
        where category is the name of the top-level class.

    Raises:
        ValueError: if a node's parent level isn't a node itself.
    """
    names = dict(classes)
    names.update({ec: e["name"] for ec, e in entries.items() if e["status"] == "current"})
    names.update(CURRENT_EC_NOT_IN_EXPASY if extra is None else extra)

    orphans = sorted(ec for ec in names if ec_parent(ec) and ec_parent(ec) not in names)
    if orphans:
        raise ValueError(f"EC numbers whose parent level is missing: {orphans[:10]}")

    nodes = {}
    for ec, name in names.items():
        parent = ec_parent(ec)
        nodes[ec] = {
            "name": name,
            "depth": ec.count(".") + 1,
            "category": names[ec.split(".")[0]],
            "parent_id": parent,
            "parent_name": names[parent] if parent else None,
        }
    return nodes


def unexplained_retired_ids(ec_ids, entries: dict[str, dict]) -> list[str]:
    """Fully-specified ids that ExPASy lists as deleted or transferred but
    that neither TRANSFERRED_EC nor CURRENT_EC_NOT_IN_EXPASY accounts for.

    Without an entry in one of those, such an id would just walk up to its
    old parent class -- usually wrong, so a new one needs a person to look
    it up in the IUBMB list and add it to one of the two tables.
    """
    return sorted(
        ec for ec in set(ec_ids)
        if "-" not in ec
        and ec in entries and entries[ec]["status"] != "current"
        and ec not in TRANSFERRED_EC and ec not in CURRENT_EC_NOT_IN_EXPASY
    )
